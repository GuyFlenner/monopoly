/**
 * Events in, a timeline out. A pure function — no React, no DOM, no clock, no i18next.
 *
 * The same shape as `a11y/narration.ts` and `sound/cues.ts`, and for the same reason: deciding
 * *what should move and for how long* is a presentation table, and a presentation table is
 * testable to the point of boredom while a `requestAnimationFrame` loop is not. Everything that
 * could be wrong about MON-701 that matters — a bot's whole turn replaying thirty seconds of
 * travel, two rolls animating out of order, a token that lands on the wrong square, a skipped
 * flourish that still takes time — is wrong in this file, where a test can see it.
 *
 * Nothing here decides whether an event happened, reads a rule, or infers a consequence. It looks
 * at `event.type`, copies the numbers the event already carries, and does arithmetic on a ring of
 * forty squares.
 *
 * ## Four animations, deliberately
 *
 * A token moving square by square, a die settling, a figure pulsing when money moves, and a house
 * popping when one is built. Four, not twenty-four. A game that animates all twenty-four event
 * types is a game whose board is never still, which is a more complete failure than shipping no
 * animation at all — and every one added here is one closer to the threshold where a player
 * reaches for the skip switch and never turns it back off.
 *
 * ## Animation is presentation lag, never data lag
 *
 * A step describes what to *draw*. The authoritative state is already in the store by the time the
 * events reach this module (`useGame` offers a view's events only after the view is committed), so
 * a timeline can never gate a command, a figure or a legal move — see `useAnimationQueue.ts` for
 * the mechanism, and `MotionQueue`'s idle contract for why a skipped animation lands on the truth
 * rather than on a computed guess.
 *
 * ## The compression ladder — three rungs, each tested
 *
 * Events outpace playback constantly: a bot's turn arrives as one burst, a reconnect replays a
 * backlog, a card sends a player round the board twice. Playing all of it in order would leave a
 * human watching a cartoon of a game that has already finished. So a batch that would take longer
 * than {@link DEFAULT_BUDGET_MS} is compressed, and the ladder is explicit:
 *
 * 1. **Full.** Every step at its natural duration; a token walks each square it passes.
 * 2. **Compressed** ({@link compress}). A move becomes one glide to its destination rather than a
 *    walk — the intermediate positions collapse, which is exactly what "do not replay thirty
 *    seconds of movement" asks for — and superseded steps drop: one dice settle rather than six,
 *    the last cash pulse per player, the last building pop per square. What survives is one
 *    readable beat per thing that happened.
 * 3. **Instant** ({@link instantly}). Every duration zero. The queue drains in a single tick and
 *    the board shows the truth. This is also what `prefers-reduced-motion` and the player's own
 *    switch select, and it is deliberately the *same code path* rather than a second one: a zero
 *    duration is a real value, so "reduced motion" exercises the same queue as "full motion" and
 *    cannot rot into an untested branch (the same argument `board/motion.ts` makes for CSS).
 */

import { nextIndex, previousIndex, TILE_COUNT } from "@/board/geometry";
import type { LoggedEvent } from "@/api";

/** How long each kind of beat lasts, in milliseconds. */
export interface TimelineDurations {
  /** One square of travel. Multiplied by the number of squares a move crosses. */
  readonly perTileMs: number;
  /** The dice settle. Matches `TUMBLE_MS`, so the tray's own flourish and the queue agree. */
  readonly diceMs: number;
  /** A figure pulsing because money moved. */
  readonly cashMs: number;
  /** A house or hotel appearing on a square. */
  readonly buildingMs: number;
}

/**
 * The default tempo.
 *
 * 90 ms a square is about as slow as a seven-square move can be without a player waiting for it:
 * the whole move is 630 ms, which is under the ~1 s at which a wait starts being felt as one.
 * `diceMs` is `TUMBLE_MS` by construction — the tray's CSS tumble and this queue's idea of how long
 * a settle takes must be one number, or the cash pulse lands while the dice are still spinning.
 */
export const DEFAULT_DURATIONS: TimelineDurations = {
  perTileMs: 90,
  diceMs: 420,
  cashMs: 260,
  buildingMs: 240,
};

/**
 * How long one batch of animation may take before it is compressed.
 *
 * Two and a bit seconds: long enough for a roll, a move and a payment to read as three separate
 * things, short enough that a human waiting behind a bot's turn does not notice they are waiting.
 * Nothing *blocks* on this figure — it decides how much flourish is shown, never whether anybody
 * may act.
 */
export const DEFAULT_BUDGET_MS = 2400;

export interface TokenMoveStep {
  readonly kind: "token_move";
  readonly id: string;
  readonly seq: number;
  readonly player: number;
  readonly from: number;
  /** The squares to draw the piece on, in travel order. Always ends on the true destination. */
  readonly path: readonly number[];
  readonly durationMs: number;
}

export interface DiceSettleStep {
  readonly kind: "dice_settle";
  readonly id: string;
  readonly seq: number;
  readonly player: number;
  readonly durationMs: number;
}

export interface CashPulseStep {
  readonly kind: "cash_pulse";
  readonly id: string;
  readonly seq: number;
  readonly player: number;
  /** Copied off the event. Carried so a test can see *which* movement of money a step is. */
  readonly delta: number;
  readonly durationMs: number;
}

export interface BuildingPopStep {
  readonly kind: "building_pop";
  readonly id: string;
  readonly seq: number;
  readonly tile: number;
  readonly houses: number;
  readonly durationMs: number;
}

export type TimelineStep = TokenMoveStep | DiceSettleStep | CashPulseStep | BuildingPopStep;

/** The last square of a move — where the piece must be standing when the step ends. */
export function destinationOf(step: TokenMoveStep): number {
  // A path is never empty: `walk` always ends with the destination. The fallback is `from` rather
  // than a `!`, so a hand-built step in a test degrades to "did not move" instead of `undefined`.
  return step.path[step.path.length - 1] ?? step.from;
}

/**
 * The squares a piece crosses going from `from` to `to`.
 *
 * Excludes the square it started on and includes the one it lands on, so `path.length` is the
 * number of squares of travel and `perTileMs * path.length` is the move's duration.
 *
 * `forward` is the event's own flag, never inferred from the two indices: "back three spaces" and
 * "forward thirty-seven" have the same endpoints, and guessing between them from arithmetic is how
 * a card that sends a player backwards animates the long way round. An index the ring does not
 * contain, or a walk that fails to arrive, degrades to a single hop — a piece that appears on its
 * destination is a missed flourish, and a piece that walks forever is a hung board.
 */
export function walk(from: number, to: number, forward: boolean): readonly number[] {
  if (!inRing(from) || !inRing(to)) {
    return [to];
  }
  if (from === to) {
    return [to];
  }
  const path: number[] = [];
  let cursor = from;
  for (let taken = 0; taken < TILE_COUNT; taken += 1) {
    cursor = forward ? nextIndex(cursor) : previousIndex(cursor);
    path.push(cursor);
    if (cursor === to) {
      return path;
    }
  }
  return [to];
}

function inRing(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < TILE_COUNT;
}

/**
 * The one beat this event is worth, or `null` for stillness.
 *
 * The mapping, and the reason for each omission:
 *
 * * `token_moved` — the piece walks. The only step with a path.
 * * `dice_rolled` — the settle. A jail roll is still a roll.
 * * `cash_changed` — a pulse on the figure, in either direction. **One beat, not two**: the
 *   direction is already said by the Announcer, shown in the log and printed on the figure, and a
 *   fourth channel guessing at the same fact from an easing curve helps nobody. A zero delta is
 *   stillness, exactly as `cueFor` and `narrate` treat it — an animation for nothing happening is
 *   a lie about the game.
 * * `rent_charged` is deliberately **absent**: every rent charge is accompanied by its own
 *   `cash_changed`, so a beat here would pulse every rent payment twice. One beat per thing that
 *   happened, not one per event.
 * * `building_changed` — the house or hotel pops. `delta` is not read: a demolition is as worth
 *   seeing as a build, and the pop is about the square changing rather than about the direction.
 * * Everything else is still. Trading, mortgaging, bidding, jail and the phase machine all produce
 *   plenty of visible change already, and none of it is movement.
 */
export function stepFor(frame: LoggedEvent, durations: TimelineDurations): TimelineStep | null {
  const { seq, event } = frame;
  switch (event.type) {
    case "token_moved": {
      const path = walk(event.from_tile, event.to_tile, event.forward);
      return {
        kind: "token_move",
        id: `${String(seq)}:token`,
        seq,
        player: event.player,
        from: event.from_tile,
        path,
        durationMs: durations.perTileMs * path.length,
      };
    }

    case "dice_rolled":
      return {
        kind: "dice_settle",
        id: `${String(seq)}:dice`,
        seq,
        player: event.player,
        durationMs: durations.diceMs,
      };

    case "cash_changed":
      return event.delta === 0
        ? null
        : {
            kind: "cash_pulse",
            id: `${String(seq)}:cash`,
            seq,
            player: event.player,
            delta: event.delta,
            durationMs: durations.cashMs,
          };

    case "building_changed":
      return {
        kind: "building_pop",
        id: `${String(seq)}:building`,
        seq,
        tile: event.tile,
        houses: event.houses,
        durationMs: durations.buildingMs,
      };

    default:
      return null;
  }
}

/** What a whole timeline costs, in milliseconds. Steps play one at a time, so this is a sum. */
export function totalMs(steps: readonly TimelineStep[]): number {
  return steps.reduce((sum, step) => sum + step.durationMs, 0);
}

/**
 * Fold adjacent moves by the same player into one walk.
 *
 * The reducer emits a move per leg — a roll, then a card that moves the player again — and two
 * legs with nothing between them are one journey to a watcher. Merging them keeps every square
 * that was crossed (the paths concatenate, so passing GO is still passing GO) while costing one
 * beat instead of two.
 *
 * Adjacency is the whole condition, and it is deliberately strict: a move, a rent payment and
 * another move are three things that happened, and collapsing them would hide the payment.
 */
function mergeRuns(
  steps: readonly TimelineStep[],
  durations: TimelineDurations,
): readonly TimelineStep[] {
  const merged: TimelineStep[] = [];
  for (const step of steps) {
    const previous = merged[merged.length - 1];
    if (
      step.kind === "token_move" &&
      previous !== undefined &&
      previous.kind === "token_move" &&
      previous.player === step.player
    ) {
      const path = [...previous.path, ...step.path];
      merged[merged.length - 1] = {
        ...previous,
        // The later `seq` wins: the step's identity is the last event it stands for, so a queue
        // that has played it has demonstrably played both legs.
        id: step.id,
        seq: step.seq,
        path,
        durationMs: durations.perTileMs * path.length,
      };
      continue;
    }
    merged.push(step);
  }
  return merged;
}

/**
 * Rung two of the ladder: one readable beat per thing that happened.
 *
 * Two independent reductions, both of which preserve *what* happened and shorten *how long it
 * takes to watch*:
 *
 * - A move keeps only its destination, so it is one glide rather than a walk. This is the
 *   "collapse the intermediate token positions" requirement: the piece still ends up on the right
 *   square, and it gets there in one beat instead of thirty-seven.
 * - A step that a later step supersedes is dropped: only the last dice settle, the last pulse per
 *   player, the last pop per square. Six bot turns arriving at once produce one settle rather than
 *   six clicks of the same die.
 *
 * Order is preserved, and a kept step keeps the position of its **last** occurrence, because that
 * is the moment the fact it shows became true.
 */
export function compress(
  steps: readonly TimelineStep[],
  durations: TimelineDurations = DEFAULT_DURATIONS,
): readonly TimelineStep[] {
  const survivors = new Set<string>();
  const seen = new Set<string>();
  // Backwards, so the *last* step for each subject is the one that survives.
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step === undefined) {
      continue;
    }
    const subject = subjectOf(step);
    if (subject === null) {
      survivors.add(step.id);
      continue;
    }
    if (seen.has(subject)) {
      continue;
    }
    seen.add(subject);
    survivors.add(step.id);
  }

  return steps
    .filter((step) => survivors.has(step.id))
    .map((step) =>
      step.kind === "token_move"
        ? { ...step, path: [destinationOf(step)], durationMs: durations.perTileMs }
        : step,
    );
}

/**
 * What a step is *about*, for the purpose of being superseded — or `null` if nothing supersedes it.
 *
 * A move is never superseded: every leg of a journey is a fact about where a piece went, and
 * dropping one would draw a piece teleporting past a square it stopped on.
 */
function subjectOf(step: TimelineStep): string | null {
  switch (step.kind) {
    case "token_move":
      return null;
    case "dice_settle":
      return "dice";
    case "cash_pulse":
      return `cash:${String(step.player)}`;
    case "building_pop":
      return `building:${String(step.tile)}`;
  }
}

/** Rung three: the same steps, taking no time. See the module docstring on why zero, not skipped. */
export function instantly(steps: readonly TimelineStep[]): readonly TimelineStep[] {
  return steps.map((step) => (step.durationMs === 0 ? step : { ...step, durationMs: 0 }));
}

export interface PlanOptions {
  readonly durations?: TimelineDurations;
  readonly budgetMs?: number;
  /**
   * Collapse everything to zero duration.
   *
   * Two callers set it, for two different reasons that want the same answer: the player asked for
   * less motion (`board/motion.ts`), or these frames are **history** rather than news — a reload's
   * `since=0` replay, or a gap the animation layer cannot honestly walk across. See
   * `useAnimationQueue.ts`.
   */
  readonly instant?: boolean;
}

/**
 * The timeline for one batch of frames.
 *
 * Frames arrive from the queue in `seq` order and already de-duplicated, so ordering here is a
 * consequence of the input rather than a sort: one event, one step, in the order they happened.
 */
export function plan(
  frames: readonly LoggedEvent[],
  options: PlanOptions = {},
): readonly TimelineStep[] {
  const durations = options.durations ?? DEFAULT_DURATIONS;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;

  const beats: TimelineStep[] = [];
  for (const frame of frames) {
    const step = stepFor(frame, durations);
    if (step !== null) {
      beats.push(step);
    }
  }
  const merged = mergeRuns(beats, durations);

  if (options.instant === true) {
    return instantly(merged);
  }
  if (totalMs(merged) <= budgetMs) {
    return merged;
  }
  const compressed = compress(merged, durations);
  return totalMs(compressed) <= budgetMs ? compressed : instantly(compressed);
}
