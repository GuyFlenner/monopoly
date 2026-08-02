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
 *
 * The card (MON-709) is the exception that proves the contract rather than breaking it. It is content,
 * not a counter, so it *is* cleared — when its own step ends, when the timeline is skipped, and again
 * when the queue drains. That is the same rule as the token overrides, for the same reason: an idle
 * queue must assert nothing. Its `nonce` is an ordinary beat, and it is there so that drawing the same
 * card twice reads as two draws.
 */

import {
  compress,
  DEFAULT_BUDGET_MS,
  DEFAULT_DURATIONS,
  destinationOf,
  readingAllowanceMs,
  totalMs,
  type CardRevealStep,
  type Deck,
  type TimelineDurations,
  type TimelineStep,
  type TokenMoveStep,
} from "./timeline";

/**
 * The card the board is holding up right now (MON-709).
 *
 * Content rather than a beat, which makes it the one field in a {@link MotionFrame} that is not a
 * number — and it is `null` whenever no card is in flight, including the whole time the queue is idle.
 * Everything on it was copied off the event stream by `timeline.ts`; nothing here computes a figure,
 * translates a key, or decides what a card means.
 */
export interface RevealedCard {
  /**
   * Monotonic, one per reveal.
   *
   * The same purpose as the other beats: a React `key`, so drawing the same card twice in a row
   * replays the entrance rather than leaving a card that was already on screen sitting still.
   */
  readonly nonce: number;
  /** Who drew it. A seat id, for a name lookup in `state.players` — six seats, six possible owners. */
  readonly player: number;
  readonly deck: Deck;
  /** The engine's i18n key for the card text. The catalogue owns the sentence (ADR-003). */
  readonly cardId: string;
  /** What the draw moved, or `null` when the events stated no figure. Never derived. */
  readonly delta: number | null;
  readonly balance: number | null;
}

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
  /** The card being held up, or `null`. Never set while the queue is idle. */
  readonly card: RevealedCard | null;
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
  card: null,
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
  /**
   * When the step before the active one ended, or `null` at the head of a timeline.
   *
   * The next step starts *there* rather than at `now`, and that is a correctness matter rather than a
   * tidiness one. Starting each step at the moment it happened to be noticed means a clock that jumps
   * — a backgrounded tab whose timers were throttled, a machine that slept, a queue advanced once
   * after a long stall — replays the whole remaining timeline at full length from the jump, so the
   * backlog *stretches* instead of draining and the board falls further behind the longer it is
   * ignored. Carrying the overrun forward means one late `advance` catches all the way up, which is
   * also what makes a zero-duration timeline drain in a single call.
   */
  private endedAt: number | null = null;

  private readonly tokens = new Map<number, number>();
  private readonly cash = new Map<number, number>();
  private readonly buildings = new Map<number, number>();
  private diceBeat = 0;
  private cardBeat = 0;
  /**
   * The card on screen, or `null`.
   *
   * Held rather than derived from `active` so that the *content* of the card and the *timing* of its
   * step stay one decision: it is set when the step begins and cleared when it ends, which is the
   * whole of "the card is up while its beat is playing".
   */
  private revealed: RevealedCard | null = null;

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
      // Frozen at construction and replaced wholesale, never mutated, so a component may compare it
      // by identity exactly as it compares the maps.
      card: this.revealed,
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
    // The allowance is the *reading* time a card asks for, granted here for the same reason `plan`
    // grants it: a card's dwell is not flourish, and a batch must not lose a token's walk to it. See
    // `readingAllowanceMs`.
    if (totalMs(this.queued) > this.budgetMs + readingAllowanceMs(this.queued, this.durations)) {
      this.queued = [...compress(this.queued, this.durations)];
    }
    this.hold();
    this.advance(now);
  }

  /**
   * Keep a piece where it was last seen until its own walk starts.
   *
   * Without this the board teleports and then walks back. The projection is committed *before* its
   * events reach the feed, so by the time a timeline is pushed `player.position` is already the
   * destination — and a piece with no override is drawn from the projection. A roll therefore played
   * as: dice settle with the piece already on square 5, then a walk that snapped it back to square 1
   * and crossed the four squares it had visibly skipped. Seeding the override with the *origin* of
   * each player's first pending move means the piece simply waits, which is what a watcher expects
   * and what makes the settle read as happening before the move.
   *
   * An override already in place is left alone: that is a walk in flight, and its current square is
   * more recent than any pending step's origin.
   */
  private hold(): void {
    for (const step of this.queued) {
      if (step.kind === "token_move" && !this.tokens.has(step.player)) {
        this.tokens.set(step.player, step.from);
      }
    }
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
          // Nothing left. Drop the overrides so every piece is drawn from the projection again, and
          // forget the clock so the next batch starts when it arrives rather than in the past.
          this.tokens.clear();
          // `finish` has already cleared the card; clearing it again makes "idle means nothing is
          // overridden" an invariant of one line rather than a consequence of two, and a test can
          // assert it without knowing which step drained last.
          this.revealed = null;
          this.endedAt = null;
          return;
        }
        // Where the previous step ended, never later than now. See the note on `endedAt`.
        this.active = {
          step: next,
          startedAt: this.endedAt === null ? now : Math.min(this.endedAt, now),
        };
        this.begin(next);
      }
      const { step, startedAt } = this.active;
      const elapsed = now - startedAt;
      if (elapsed >= step.durationMs) {
        this.finish(step);
        this.endedAt = startedAt + step.durationMs;
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
    this.endedAt = null;
    this.tokens.clear();
    // The card goes with it, which is what makes "put this card down" and "catch up" one gesture
    // rather than two mechanisms with two timers (MON-709). Nothing is lost by it: the card said the
    // engine's own sentence, the figure it showed came off an event that is in the log, and the
    // dossier has been showing the new balance the whole time.
    this.revealed = null;
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
      case "card_reveal":
        this.cardBeat += 1;
        this.revealed = revealedFrom(step, this.cardBeat);
        return;
    }
  }

  /**
   * A finished walk leaves its piece on the destination until the whole timeline drains; a finished
   * card comes off the board.
   *
   * The asymmetry is the idle contract at work. A token override outlives its step because the piece
   * has to stand somewhere until the projection takes over, and the projection agrees with it. A card
   * has no counterpart in the projection at all — `GameStateView` does not carry "the card showing" —
   * so keeping it up after its beat would be this class inventing a fact and holding it indefinitely.
   */
  private finish(step: TimelineStep): void {
    if (step.kind === "token_move") {
      this.tokens.set(step.player, destinationOf(step));
    }
    if (step.kind === "card_reveal") {
      this.revealed = null;
    }
  }
}

/** A step's card content, plus the beat that makes it a fresh reveal. A copy, not a computation. */
function revealedFrom(step: CardRevealStep, nonce: number): RevealedCard {
  return {
    nonce,
    player: step.player,
    deck: step.deck,
    cardId: step.cardId,
    delta: step.delta,
    balance: step.balance,
  };
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
