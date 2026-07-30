/**
 * The queue that plays a timeline. Pure TypeScript: no React, no DOM, and **no clock of its own**.
 *
 * Time comes in as an argument. `push`, `advance` and `nextWakeMs` are all handed the current
 * millisecond by whoever owns the timer, which makes every question a test wants to ask — "where is
 * the piece 200 ms in", "what does skipping mid-flight leave on screen", "does a burst compress" —
 * a matter of calling a method with a number rather than of faking `requestAnimationFrame`. The
 * hook in `useAnimationQueue.ts` is the only thing in this package that reads a clock.
 *
 * ## The idle contract, which is the whole safety argument
 *
 * **When the queue is idle it reports no token positions at all.** It does not report the last
 * position it computed; it reports nothing, and the board therefore draws `player.position` — the
 * projection's own figure, which is the server's answer and has been in the store the whole time.
 *
 * That is what makes "skipping mid-flight lands the piece at its true position" structural rather
 * than arithmetic. {@link MotionQueue.skip} does not work out where a piece should end up: it
 * throws the timeline away, which makes the queue idle, which makes the board read the truth. There
 * is no expression here that could disagree with the engine, because there is no expression here at
 * all.
 *
 * The corollary is the non-blocking property. A `MotionFrame` is an *override* on presentation,
 * never a source: every figure, every legal command and every piece has an answer without this
 * class ever being consulted, so an animation cannot gate an action even if this file hangs.
 *
 * ## Beats pulse; pieces travel
 *
 * The dice, cash and building beats are counters rather than booleans. A counter that only ever
 * goes up is a value a component can use as a React `key` to replay a CSS animation (the idiom
 * `DiceTray`'s `Die` established), and it never resets — so going idle cannot make a figure pulse a
 * second time for a payment that finished a minute ago.
 */

import {
  compress,
  DEFAULT_BUDGET_MS,
  DEFAULT_DURATIONS,
  destinationOf,
  totalMs,
  type TimelineDurations,
  type TimelineStep,
  type TokenMoveStep,
} from "./timeline";

/**
 * What the screen should show right now.
 *
 * Every map is an override with a fallback in the projection, and an absent entry means "use the
 * projection's own answer". Nothing here is a fact about the game.
 */
export interface MotionFrame {
  /** Where a piece is being drawn, by player id. Empty whenever the queue is idle. */
  readonly tokens: ReadonlyMap<number, number>;
  /** A monotonic beat per player, bumped when their figure should pulse. */
  readonly cash: ReadonlyMap<number, number>;
  /** A monotonic beat per square, bumped when its buildings should pop. */
  readonly buildings: ReadonlyMap<number, number>;
  /** A monotonic beat, bumped when the dice should settle. */
  readonly dice: number;
  /** Steps still to play, counting the one in flight. Zero means the screen matches the truth. */
  readonly remaining: number;
}

export interface MotionQueueOptions {
  readonly durations?: TimelineDurations;
  /** Pending playback longer than this is compressed on arrival. See `timeline.ts`'s ladder. */
  readonly budgetMs?: number;
}

/** The empty frame: nothing moving, nothing overridden. */
export const STILL: MotionFrame = {
  tokens: new Map(),
  cash: new Map(),
  buildings: new Map(),
  dice: 0,
  remaining: 0,
};

interface Active {
  readonly step: TimelineStep;
  readonly startedAt: number;
}

export class MotionQueue {
  private readonly durations: TimelineDurations;
  private readonly budgetMs: number;

  private queued: TimelineStep[] = [];
  private active: Active | null = null;

  private readonly tokens = new Map<number, number>();
  private readonly cash = new Map<number, number>();
  private readonly buildings = new Map<number, number>();
  private diceBeat = 0;

  constructor(options: MotionQueueOptions = {}) {
    this.durations = options.durations ?? DEFAULT_DURATIONS;
    this.budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  }

  /** Steps still to play, counting the one in flight. */
  get remaining(): number {
    return this.queued.length + (this.active === null ? 0 : 1);
  }

  /** Nothing is moving, so the screen is the projection's own. */
  get idle(): boolean {
    return this.remaining === 0;
  }

  /** A fresh snapshot. New maps every call, so React can compare by identity and re-render. */
  get frame(): MotionFrame {
    return {
      tokens: new Map(this.tokens),
      cash: new Map(this.cash),
      buildings: new Map(this.buildings),
      dice: this.diceBeat,
      remaining: this.remaining,
    };
  }

  /**
   * Accept a timeline and start it playing.
   *
   * The batch is appended rather than replacing what is in flight, because two batches are two
   * things that happened and the second does not undo the first. What *is* re-decided is how long
   * the whole backlog may take: `plan` sized one batch against the budget without knowing what was
   * already queued, and a reconnect delivers its backlog one frame per socket message — so the
   * only place the *total* pressure is visible is here, and this is where the second rung of the
   * ladder is applied to it (`timeline.ts`).
   */
  push(steps: readonly TimelineStep[], now: number): void {
    if (steps.length > 0) {
      this.queued = [...this.queued, ...steps];
    }
    if (totalMs(this.queued) > this.budgetMs) {
      this.queued = [...compress(this.queued, this.durations)];
    }
    this.advance(now);
  }

  /**
   * Retire whatever has finished, start whatever is next, and place the travelling piece.
   *
   * Safe to call at any moment and any number of times: it derives everything from `now` and the
   * step in flight, so an early call is a no-op and a late one catches up by retiring several steps
   * in one pass. A zero-duration timeline drains entirely in the first call, which is how reduced
   * motion and a replayed backlog take the same code path as a played one.
   */
  advance(now: number): void {
    for (;;) {
      if (this.active === null) {
        const next = this.queued.shift();
        if (next === undefined) {
          // Nothing left. Drop the overrides so every piece is drawn from the projection again.
          this.tokens.clear();
          return;
        }
        this.active = { step: next, startedAt: now };
        this.begin(next);
      }
      const { step, startedAt } = this.active;
      const elapsed = now - startedAt;
      if (elapsed >= step.durationMs) {
        this.finish(step);
        this.active = null;
        continue;
      }
      if (step.kind === "token_move") {
        this.tokens.set(step.player, squareAt(step, elapsed));
      }
      return;
    }
  }

  /**
   * How long until the next visible change, or `null` when there is nothing to wait for.
   *
   * A step-based animation only needs waking at a boundary — the next square of a walk, or the end
   * of a beat — so the owner of the timer never runs a frame loop and an idle board costs nothing.
   */
  nextWakeMs(now: number): number | null {
    if (this.active === null) {
      return this.queued.length > 0 ? 0 : null;
    }
    const { step, startedAt } = this.active;
    const elapsed = Math.max(now - startedAt, 0);
    const remainingMs = step.durationMs - elapsed;
    if (step.kind !== "token_move") {
      return Math.max(remainingMs, 0);
    }
    const perSquare = step.durationMs / step.path.length;
    if (perSquare <= 0) {
      return 0;
    }
    const nextBoundary = (Math.floor(elapsed / perSquare) + 1) * perSquare;
    return Math.max(Math.min(nextBoundary, step.durationMs) - elapsed, 0);
  }

  /**
   * Fast-forward to now: throw the timeline away.
   *
   * Deliberately **not** "apply every remaining step at once". Bumping the beats for a dozen
   * pending steps would fire a dozen pulses simultaneously, which is a louder screen than the one
   * the player asked to quieten, and setting the token overrides to the last step's destination
   * would be this class computing a position the projection already knows. Dropping everything is
   * both quieter and provably correct — see the idle contract in the module docstring.
   */
  skip(): void {
    this.queued = [];
    this.active = null;
    this.tokens.clear();
  }

  /** Bump the beat a step is responsible for, and place a piece on the first square of its walk. */
  private begin(step: TimelineStep): void {
    switch (step.kind) {
      case "token_move":
        this.tokens.set(step.player, squareAt(step, 0));
        return;
      case "dice_settle":
        this.diceBeat += 1;
        return;
      case "cash_pulse":
        this.cash.set(step.player, (this.cash.get(step.player) ?? 0) + 1);
        return;
      case "building_pop":
        this.buildings.set(step.tile, (this.buildings.get(step.tile) ?? 0) + 1);
        return;
    }
  }

  /** A finished walk leaves its piece on the destination until the whole timeline drains. */
  private finish(step: TimelineStep): void {
    if (step.kind === "token_move") {
      this.tokens.set(step.player, destinationOf(step));
    }
  }
}

/**
 * Which square of a walk `elapsed` milliseconds in.
 *
 * Clamped at both ends: a negative elapsed (two clocks disagreeing by a millisecond) shows the
 * first square rather than reading off the end of the array, and an over-run shows the destination.
 */
function squareAt(step: TokenMoveStep, elapsed: number): number {
  const squares = step.path.length;
  if (squares === 0) {
    return step.from;
  }
  const perSquare = step.durationMs / squares;
  const index =
    perSquare <= 0
      ? squares - 1
      : Math.min(Math.max(Math.floor(elapsed / perSquare), 0), squares - 1);
  return step.path[index] ?? destinationOf(step);
}
