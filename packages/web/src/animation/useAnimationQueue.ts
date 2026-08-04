/**
 * The wire between the event stream and the board's motion (MON-701).
 *
 * Called **once**, from whatever renders a live game — the same shape and the same
 * single-subscription discipline as `useEventNarration` (MON-411) and `useSoundCues` (MON-706). It
 * reads the same de-duplicated feed those two read (`useEventFeed`, which is the queue's own
 * cursor), so one roll produces one settle, one sentence and one click, and no component anywhere
 * else handles an event in order to move something. A `<Tile>` that animated off its own props
 * would move twice for a view that was refetched and not at all for a frame that arrived over the
 * socket.
 *
 * It owns the only clock in the animation layer. `timeline.ts` is a pure mapping and `queue.ts` is
 * a pure state machine over an injected `now`; the `setTimeout` is here, and it is a wake at the
 * next visible boundary rather than a frame loop, so a still board costs nothing.
 *
 * ## Nothing blocks on any of this
 *
 * The return value is an **override on presentation** and never a source. The action bar renders
 * `legalCommands` from the store the moment they arrive, every figure comes off the projection, and
 * a piece with no entry in `tokens` is drawn at `player.position`. So a command can be sent while a
 * piece is mid-travel, a rejected mutation is reported while the dice are settling, and if this
 * hook threw on every frame the game would still be fully playable — which is the property
 * `useAnimationQueue.test.tsx` asserts by dispatching a command mid-walk.
 *
 * ## Replay is not news — and the distinction comes from the cursor, not from a guess
 *
 * A reload fetches with `since=0` and is handed the whole game in one batch; a reconnect asks for
 * `?since=<cursor>` and is pushed a backlog. Animating either would show a player a cartoon of a
 * game that has already finished, and MON-701 says so explicitly.
 *
 * The signal is the `seq` continuity the event plumbing already provides, and it answers both cases
 * with one rule: **animate only frames that continue where the animation left off.**
 *
 * * Nothing animated yet (`lastSeq === 0`) — whatever arrives is history, however short. A brand-new
 *   game's setup events are history too, which is right: nobody watched them happen.
 * * A gap (`frames[0].seq !== lastSeq + 1`) — the socket replayed a backlog, or the bounded event
 *   log dropped frames (`EventQueue.droppedThrough`). Walking a piece from a position we never saw
 *   would be animating a journey that did not happen.
 *
 * Both answer `instant: true`, which is a zero-duration timeline rather than a second code path:
 * the queue drains in one tick and the board shows the truth. Everything contiguous animates.
 *
 * History says one thing more than reduced motion does, and only about the card: it sets
 * `history: true`, which drops the card step instead of shortening it. A reload replaying forty
 * turns must not hold up the card someone drew in the eleventh, whereas a player who merely asked
 * for a still board must still be shown the card they just drew (MON-709).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { LoggedEvent } from "@/api";
import { useMotionPreference } from "@/board/motion";
import { useEventFeed } from "@/game";

import { cardDwellMs, useCardDwellPreference } from "./cardDwell";
import { MotionQueue, STILL, type MotionFrame } from "./queue";
import { DEFAULT_DURATIONS, plan, type TimelineDurations } from "./timeline";

export interface AnimationQueueOptions {
  readonly durations?: TimelineDurations;
  readonly budgetMs?: number;
  /** The clock. Injected so a test can step time by hand rather than sleep through a walk. */
  readonly now?: () => number;
}

export interface AnimationState extends MotionFrame {
  /** Fast-forward to now. Idempotent, and safe to call when nothing is moving. */
  readonly skip: () => void;
  /** Something is moving, so the skip affordance has something to do. */
  readonly playing: boolean;
}

/**
 * Whether this batch is history rather than news. See the module docstring for the reasoning.
 *
 * `lastSeq` is the highest `seq` this hook has already turned into a timeline — deliberately its
 * own figure and not `EventQueue.cursor`, because the cursor moves when a *frame* is accepted and
 * this question is about what the *animation* has seen.
 */
export function isReplay(frames: readonly LoggedEvent[], lastSeq: number): boolean {
  const first = frames[0];
  if (first === undefined) {
    return false;
  }
  return lastSeq === 0 || first.seq !== lastSeq + 1;
}

export function useAnimationQueue(options: AnimationQueueOptions = {}): AnimationState {
  const { budgetMs, now: clock } = options;
  const now = clock ?? Date.now;
  const { skip: skipMotion } = useMotionPreference();
  /*
    How long the table asked a card to stay up (MON-719).

    Read *here* rather than passed in by `GameScreen`, for the same reason `useMotionPreference` is
    read here: every surface that plays a timeline — the game screen and the replay viewer — must
    honour the same choice, and a preference a caller has to remember to forward is one a new caller
    will forget. An explicit `options.durations` still wins outright, which is what keeps the tests
    driving fixed numbers rather than a stored one.
  */
  const { seconds } = useCardDwellPreference();
  const durations = useMemo(
    () => options.durations ?? { ...DEFAULT_DURATIONS, cardMs: cardDwellMs(seconds) },
    [options.durations, seconds],
  );

  const queue = useRef<MotionQueue | null>(null);
  queue.current ??= new MotionQueue({
    durations,
    ...(budgetMs === undefined ? {} : { budgetMs }),
  });
  const held = queue.current;

  const [frame, setFrame] = useState<MotionFrame>(STILL);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The highest `seq` already planned. The replay test's left-hand side. */
  const lastSeq = useRef(0);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  /**
   * Advance the queue, publish the snapshot, and book the next wake.
   *
   * A ref rather than a `useCallback` closing over itself: the timer's callback has to be able to
   * re-book, and a callback that re-creates itself every render would cancel a walk in progress
   * every time an unrelated prop changed.
   */
  const pump = useRef<() => void>(() => undefined);
  pump.current = (): void => {
    const at = now();
    held.advance(at);
    setFrame(held.frame);
    clearTimer();
    const wake = held.nextWakeMs(now());
    if (wake !== null) {
      timer.current = setTimeout(
        () => {
          timer.current = null;
          pump.current();
        },
        Math.max(wake, 0),
      );
    }
  };

  useEventFeed((frames) => {
    if (frames.length === 0) {
      return;
    }
    // The two reasons for a still board are kept apart here, and they part company at the card
    // (MON-709): a player who asked for less motion still gets to read the card, and a batch that is
    // history gets none — see `PlanOptions.instant` and `PlanOptions.history`.
    const history = isReplay(frames, lastSeq.current);
    const instant = skipMotion || history;
    const last = frames[frames.length - 1];
    if (last !== undefined) {
      lastSeq.current = Math.max(lastSeq.current, last.seq);
    }
    held.push(
      plan(frames, {
        durations,
        ...(budgetMs === undefined ? {} : { budgetMs }),
        instant,
        history,
      }),
      now(),
    );
    pump.current();
  });

  // The timer is the only resource this hook holds, and a walk outliving its screen would call
  // `setFrame` on an unmounted component every 90 ms until it finished.
  useEffect(() => clearTimer, [clearTimer]);

  const skip = useCallback(() => {
    held.skip();
    clearTimer();
    setFrame(held.frame);
  }, [held, clearTimer]);

  return { ...frame, skip, playing: frame.remaining > 0 };
}
