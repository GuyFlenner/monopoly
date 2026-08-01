/**
 * What the events **said**, folded up to one position in the log (MON-705).
 *
 * ## This is not a reducer, and the difference is the whole design
 *
 * `apply(state, command) -> (state, events)` lives in the engine and nowhere else (ADR-005). A
 * replay viewer that rebuilt `GameState` from an event log would be a second implementation of the
 * rules written in TypeScript — the one place the drift would be invisible, because it would agree
 * with the engine for every game anybody happened to test.
 *
 * So this module derives **nothing**. It copies. Every field below is a value some event states
 * outright, in the event's own words:
 *
 * | Fact | The event that states it | The field |
 * |---|---|---|
 * | where a token stands | `token_moved` | `to_tile` |
 * | what a seat holds in cash | `cash_changed` | `balance` (not the delta — no addition here) |
 * | who owns a square | `property_acquired`, `trade_executed`, `player_bankrupted` | `player`, the offer's tiles, `tiles_transferred`/`shares` |
 * | how many houses stand on a square | `building_changed` | `houses` (the count *after* the change) |
 * | whether a square is mortgaged | `mortgage_changed` | `mortgaged` |
 * | who is in jail | `sent_to_jail` / `left_jail` | the event's existence |
 * | who is out of the game | `player_bankrupted` | `player` |
 * | whose turn it is, and which turn | `turn_started` | `player`, `turn_number` |
 * | the last throw | `dice_rolled` | `first`, `second`, `total` |
 * | who won | `game_ended` | `winner` |
 *
 * **Anything not in that table is `undefined`, and a viewer renders `undefined` as nothing.** Rent
 * is charged by `rent_charged` and the money moves in `cash_changed`, so rent states no fact of its
 * own here. `sent_to_jail` does not carry a tile, so it does not move a token — the `token_moved`
 * that accompanies it does. Net worth, whether a group is complete, what rent a square would charge
 * next: no event states any of them, so this module cannot and does not answer them.
 *
 * ## Why the table is exhaustive
 *
 * `Record<GameEventType, Folder | null>` is the same device `panels/EventLogLines.ts` uses: an event
 * type the engine adds is a **compile error** here rather than a fact that silently stops being
 * tracked. `null` means "states nothing this module can copy", and every `null` below says why.
 *
 * ## Pure, and re-foldable from scratch
 *
 * No React, no i18next, no clock, no mutation — {@link foldEvent} returns a new value, and
 * {@link factsAt} folds from the start of the log every time it is asked. That is O(position) per
 * step rather than an incremental cursor, and it is the right trade: scrubbing backwards is exactly
 * as correct as scrubbing forwards, because there is only one code path and it runs forwards.
 */

import type { EventOfType, GameEventType, LoggedEvent } from "@/api";

/**
 * One seat, as the log has described it so far.
 *
 * Every field is `| undefined` rather than optional, and that is deliberate under
 * `exactOptionalPropertyTypes`: "no event has said where this token is" is a fact worth holding, and
 * a missing property and a property holding `undefined` should not be two ways to say it.
 */
export interface SeatFacts {
  /** The square a `token_moved` last put this token on. */
  readonly position: number | undefined;
  /** The balance a `cash_changed` last reported. Never a sum of deltas — see the header. */
  readonly cash: number | undefined;
  readonly inJail: boolean | undefined;
  readonly bankrupt: boolean | undefined;
}

/** One square, as the log has described it so far. */
export interface SquareFacts {
  /** The player a transfer named, or `null` where the transfer named the bank. */
  readonly owner: number | null | undefined;
  /** `building_changed.houses` — the engine's own count after the change. */
  readonly houses: number | undefined;
  readonly mortgaged: boolean | undefined;
}

export interface ReplayFacts {
  /** How many log entries are folded in. `0` is "before the first event". */
  readonly applied: number;
  /** The `seq` of the last entry folded in; `0` when none is. */
  readonly seq: number;
  readonly turnNumber: number | undefined;
  /** The seat `turn_started` last named. Not "who may act": that is a rule. */
  readonly actingPlayer: number | undefined;
  readonly dice: DiceFacts | undefined;
  /** Only the seats some event has mentioned. A seat with no facts is absent. */
  readonly seats: ReadonlyMap<number, SeatFacts>;
  /** Only the squares some event has mentioned. */
  readonly squares: ReadonlyMap<number, SquareFacts>;
  /** `game_ended.winner`: a player id, `null` for a game that ended with nobody, else unstated. */
  readonly winner: number | null | undefined;
  /** Whether a `game_ended` has been folded in. */
  readonly finished: boolean;
}

/** The three numbers a `dice_rolled` carries. Copied; nothing here adds the two dice up. */
export interface DiceFacts {
  readonly first: number;
  readonly second: number;
  readonly total: number;
}

const NO_SEAT_FACTS: SeatFacts = {
  position: undefined,
  cash: undefined,
  inJail: undefined,
  bankrupt: undefined,
};

const NO_SQUARE_FACTS: SquareFacts = {
  owner: undefined,
  houses: undefined,
  mortgaged: undefined,
};

/** Position zero: the log has said nothing yet, so nothing is known. */
export const NOTHING_STATED: ReplayFacts = {
  applied: 0,
  seq: 0,
  turnNumber: undefined,
  actingPlayer: undefined,
  dice: undefined,
  seats: new Map(),
  squares: new Map(),
  winner: undefined,
  finished: false,
};

// --- Writing one fact -------------------------------------------------------
// Each helper copies the map, so a folded value never shares a mutable collection with the value
// it came from. A viewer holding position 12 while the user steps to 13 must keep seeing 12.

function withSeat(facts: ReplayFacts, playerId: number, patch: Partial<SeatFacts>): ReplayFacts {
  const seats = new Map(facts.seats);
  seats.set(playerId, { ...(seats.get(playerId) ?? NO_SEAT_FACTS), ...patch });
  return { ...facts, seats };
}

function withSquare(
  facts: ReplayFacts,
  tileIndex: number,
  patch: Partial<SquareFacts>,
): ReplayFacts {
  const squares = new Map(facts.squares);
  squares.set(tileIndex, { ...(squares.get(tileIndex) ?? NO_SQUARE_FACTS), ...patch });
  return { ...facts, squares };
}

/** Ownership of several squares at once, as a transfer states it. */
function withOwners(
  facts: ReplayFacts,
  tiles: readonly number[],
  owner: number | null,
): ReplayFacts {
  return tiles.reduce((carried, tile) => withSquare(carried, tile, { owner }), facts);
}

/**
 * A creditor as an owner: `"bank"` is not a player, so a square that went to the bank has no owner.
 *
 * `null` here is the same `null` `PropertyState.owner` uses for an unowned square — the projection's
 * own spelling, not an invention of this module.
 */
function ownerOf(creditor: number | "bank"): number | null {
  return creditor === "bank" ? null : creditor;
}

// --- The table --------------------------------------------------------------

type Folder<T extends GameEventType> = (facts: ReplayFacts, event: EventOfType<T>) => ReplayFacts;

type FolderTable = { readonly [T in GameEventType]: Folder<T> | null };

const TABLE: FolderTable = {
  turn_started: (facts, event) => ({
    ...facts,
    turnNumber: event.turn_number,
    actingPlayer: event.player,
  }),

  dice_rolled: (facts, event) => ({
    ...facts,
    dice: { first: event.first, second: event.second, total: event.total },
  }),

  token_moved: (facts, event) => withSeat(facts, event.player, { position: event.to_tile }),

  // `balance` rather than `delta`: the engine has already done the arithmetic and put the answer on
  // the event, so a replay that added deltas up would be a second ledger — and the first one to
  // disagree would be the one with no test behind it.
  cash_changed: (facts, event) => withSeat(facts, event.player, { cash: event.balance }),

  // States what was paid and by whom, which the log narrates. The *money* moves in the
  // `cash_changed` beside it, and the ownership was stated when the square was acquired.
  rent_charged: null,

  property_acquired: (facts, event) => withSquare(facts, event.tile, { owner: event.player }),

  // An auction's opening, bidding and hammer say who is bidding what. The square only changes hands
  // in the `property_acquired(via="auction")` the engine emits when it does.
  auction_started: null,
  bid_placed: null,
  bidder_withdrew: null,
  auction_ended: null,

  // Which deck was drawn from. What the card *did* arrives as its own events — a move, a payment, a
  // trip to jail — and reading a card's effect out of its id would be the engine's card table living
  // here.
  card_drawn: null,

  // Jail is a flag, not a place, as far as this event goes: `SentToJail` carries no tile, so nothing
  // here moves a token. The `token_moved` the engine emits alongside it does that.
  sent_to_jail: (facts, event) => withSeat(facts, event.player, { inJail: true }),
  left_jail: (facts, event) => withSeat(facts, event.player, { inJail: false }),

  building_changed: (facts, event) => withSquare(facts, event.tile, { houses: event.houses }),

  mortgage_changed: (facts, event) => withSquare(facts, event.tile, { mortgaged: event.mortgaged }),

  // An offer on the table, an answer, a withdrawal. None of the three moves anything.
  trade_proposed: null,
  trade_declined: null,
  trade_cancelled: null,

  /*
   * The one event whose ownership fact is a *swap*, and it is still a copy rather than a derivation.
   *
   * `rules/trade.py` emits no `PropertyAcquired` for a trade — `TradeExecuted(offer=…)` is the whole
   * statement — so the offer's own fields are where the new owners are written down: `give` is what
   * the proposer hands over (so those squares are the recipient's), `receive` is what the proposer
   * gets (so those are the proposer's). The engine's docstrings name both sides in those words.
   *
   * The cash in the offer is deliberately ignored: it is an *amount*, and the balances it produced
   * arrive on the `cash_changed` events the same command emitted. Two sources for one balance is how
   * a replay ends up showing money that never existed.
   */
  trade_executed: (facts, event) => {
    const { proposer, recipient, give, receive } = event.offer;
    return withOwners(withOwners(facts, give.tiles, recipient), receive.tiles, proposer);
  },

  // A shortfall, and its settlement. Both are money, and money is `cash_changed`'s to state.
  debt_incurred: null,
  debt_settled: null,

  /*
   * The estate, divided exactly as the event divides it.
   *
   * `shares` is present when more than one creditor has a claim (G-7), and each share names its own
   * creditor and its own tiles — so the shares are read when they are there, and `tiles_transferred`
   * (the whole estate, credited to the single `creditor`) when they are not. Attributing every tile
   * to the *principal* creditor in a multi-creditor bankruptcy would be a guess dressed as a fact.
   *
   * `cash_transferred` is skipped for the reason `trade_executed`'s cash is: it is an amount, and the
   * balances are on the `cash_changed` events beside it.
   */
  player_bankrupted: (facts, event) => {
    const bankrupted = withSeat(facts, event.player, { bankrupt: true });
    if (event.shares.length > 0) {
      return event.shares.reduce(
        (carried, share) => withOwners(carried, share.tiles, ownerOf(share.creditor)),
        bankrupted,
      );
    }
    return withOwners(bankrupted, event.tiles_transferred, ownerOf(event.creditor));
  },

  // The machine's own bookkeeping. `EventLogLines.ts` stays quiet about it for the same reason:
  // a phase is not a fact about the table a player can see.
  phase_changed: null,

  game_ended: (facts, event) => ({
    ...facts,
    finished: true,
    winner: event.winner ?? null,
  }),
};

/**
 * Fold one logged event in.
 *
 * `applied` and `seq` advance even for an event that states nothing, because they describe the
 * *position in the log*, not the contents of the facts: "event 12 of 96" has to count the phase
 * changes a player never sees, or the position the viewer shows and the position the slider holds
 * would be two different numbers.
 */
export function foldEvent(facts: ReplayFacts, entry: LoggedEvent): ReplayFacts {
  // The cast is the price of a discriminated-union lookup table in TypeScript, and it is the same
  // one `EventLogLines.ts` pays: `TABLE[type]` is the union of every folder, and TS cannot see that
  // the entry just indexed by `event.type` takes exactly this event. The safety that matters — every
  // event type has an entry, and each entry takes the matching event — is enforced at the table.
  const folder = TABLE[entry.event.type] as Folder<GameEventType> | null;
  const folded = folder === null ? facts : folder(facts, entry.event);
  return { ...folded, applied: facts.applied + 1, seq: entry.seq };
}

/**
 * The facts as of `position` — that is, after the first `position` entries of `events`.
 *
 * `position` is clamped rather than checked: a slider handed a stale maximum, or a `-1` from an
 * arithmetic slip in a caller, should show the first or the last frame rather than throw a viewer
 * away mid-scrub. The clamp is the only opinion this function has.
 */
export function factsAt(events: readonly LoggedEvent[], position: number): ReplayFacts {
  const bounded = Math.max(0, Math.min(Math.trunc(position), events.length));
  let facts = NOTHING_STATED;
  for (let index = 0; index < bounded; index += 1) {
    const entry = events[index];
    if (entry === undefined) {
      continue;
    }
    facts = foldEvent(facts, entry);
  }
  return facts;
}

/** The seat's facts, or the all-unstated value. Saves every caller the same `??`. */
export function seatFacts(facts: ReplayFacts, playerId: number): SeatFacts {
  return facts.seats.get(playerId) ?? NO_SEAT_FACTS;
}

/** The square's facts, or the all-unstated value. */
export function squareFacts(facts: ReplayFacts, tileIndex: number): SquareFacts {
  return facts.squares.get(tileIndex) ?? NO_SQUARE_FACTS;
}
