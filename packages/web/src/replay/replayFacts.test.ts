/**
 * The accumulator, event type by event type.
 *
 * Two properties are worth more than the rest of this file put together, and both are stated as
 * tests rather than as comments:
 *
 * 1. **Every event type is accounted for.** The table is `Record<GameEventType, …>`, so the compiler
 *    already refuses a missing entry — but "accounted for" also means the ones that state nothing
 *    really state nothing, which the compiler cannot see. `states nothing` below walks every silent
 *    type and asserts the facts come back *identical* apart from the position counter.
 * 2. **A fact only appears if an event stated it.** Each case asserts the field it expects *and*
 *    that the neighbouring fields are still `undefined`. Without the second half, an implementation
 *    that filled everything in with plausible defaults would pass — and a plausible default is
 *    exactly the derivation this module exists not to do.
 */

import { describe, expect, it } from "vitest";

import type { EventOfType, GameEvent, GameEventType, LoggedEvent } from "@/api";
import { loggedEvent } from "@/test/fixtures";

import {
  factsAt,
  foldEvent,
  NOTHING_STATED,
  seatFacts,
  squareFacts,
  type ReplayFacts,
} from "./replayFacts";

/** Fold a list of bare events, numbering them from `seq` 1 as the server does. */
function fold(...events: readonly GameEvent[]): ReplayFacts {
  return factsAt(
    events.map((event, index) => loggedEvent(index + 1, event)),
    events.length,
  );
}

const TURN_1: GameEvent = { type: "turn_started", player: 0, turn_number: 1 };

const ROLLED: GameEvent = {
  type: "dice_rolled",
  player: 0,
  first: 3,
  second: 4,
  total: 7,
  doubles_streak: 0,
  purpose: "move",
};

const MOVED: GameEvent = {
  type: "token_moved",
  player: 0,
  from_tile: 0,
  to_tile: 7,
  forward: true,
  passed_go: false,
};

const PAID: GameEvent = {
  type: "cash_changed",
  player: 0,
  delta: -200,
  reason: "purchase",
  balance: 1300,
  counterparty: "bank",
};

const BOUGHT: GameEvent = {
  type: "property_acquired",
  player: 0,
  tile: 7,
  price: 200,
  via: "purchase",
};

describe("NOTHING_STATED", () => {
  it("knows nothing at all", () => {
    expect(NOTHING_STATED.applied).toBe(0);
    expect(NOTHING_STATED.seq).toBe(0);
    expect(NOTHING_STATED.turnNumber).toBeUndefined();
    expect(NOTHING_STATED.actingPlayer).toBeUndefined();
    expect(NOTHING_STATED.dice).toBeUndefined();
    expect(NOTHING_STATED.winner).toBeUndefined();
    expect(NOTHING_STATED.finished).toBe(false);
    expect(NOTHING_STATED.seats.size).toBe(0);
    expect(NOTHING_STATED.squares.size).toBe(0);
  });

  it("is not mutated by folding onto it", () => {
    // The value is exported and shared, so a fold that wrote through it would poison every later
    // replay in the session — including the one already on screen.
    foldEvent(NOTHING_STATED, loggedEvent(1, MOVED));
    expect(NOTHING_STATED.seats.size).toBe(0);
    expect(NOTHING_STATED.applied).toBe(0);
  });
});

describe("turn_started", () => {
  it("states the turn number and the acting seat, and nothing else", () => {
    const facts = fold(TURN_1);
    expect(facts.turnNumber).toBe(1);
    expect(facts.actingPlayer).toBe(0);
    // A turn beginning says nothing about where the seat stands or what it holds.
    expect(facts.seats.size).toBe(0);
    expect(facts.dice).toBeUndefined();
  });
});

describe("dice_rolled", () => {
  it("copies the three numbers the throw carries", () => {
    const facts = fold(ROLLED);
    expect(facts.dice).toEqual({ first: 3, second: 4, total: 7 });
  });

  it("does not move the token that rolled", () => {
    // Movement is `token_moved`'s to state. A roll of 7 from GO reaching square 7 is a *rule*
    // (`from + total`, with a wrap at forty), and the rule lives in the engine.
    const facts = fold(TURN_1, ROLLED);
    expect(seatFacts(facts, 0).position).toBeUndefined();
  });

  it("does not name the acting seat", () => {
    // `dice_rolled` carries a `player`, and it is the roller rather than an answer to "whose turn".
    // Only `turn_started` states that, so a log opening mid-turn shows no acting seat.
    expect(fold(ROLLED).actingPlayer).toBeUndefined();
  });
});

describe("token_moved", () => {
  it("puts the token on the square the event names", () => {
    const facts = fold(MOVED);
    expect(seatFacts(facts, 0).position).toBe(7);
    // Not `from_tile`, and not a step count: the destination is stated outright.
    expect(seatFacts(facts, 0).cash).toBeUndefined();
  });

  it("leaves the seats it does not name alone", () => {
    const facts = fold(MOVED);
    expect(facts.seats.has(1)).toBe(false);
    expect(seatFacts(facts, 1).position).toBeUndefined();
  });
});

describe("cash_changed", () => {
  it("takes the balance the engine reported", () => {
    expect(seatFacts(fold(PAID), 0).cash).toBe(1300);
  });

  it("never adds deltas up", () => {
    // Two payments in a row: the answer is the *last balance*, not 1500 - 200 - 100. If this module
    // did the arithmetic it would need a starting balance no event states, and the first rounding or
    // ordering difference would put a number on screen that no ledger backs.
    const second: GameEvent = { ...PAID, delta: -100, balance: 1200 };
    expect(seatFacts(fold(PAID, second), 0).cash).toBe(1200);
  });
});

describe("property_acquired", () => {
  it("names the new owner of the square", () => {
    const facts = fold(BOUGHT);
    expect(squareFacts(facts, 7).owner).toBe(0);
    // A purchase says nothing about buildings or mortgages on the square.
    expect(squareFacts(facts, 7).houses).toBeUndefined();
    expect(squareFacts(facts, 7).mortgaged).toBeUndefined();
  });

  it("does not touch the buyer's cash — that is the ledger's line", () => {
    expect(seatFacts(fold(BOUGHT), 0).cash).toBeUndefined();
  });
});

describe("building_changed", () => {
  it("takes the engine's count after the change, not the delta", () => {
    const facts = fold(
      { type: "building_changed", tile: 7, houses: 3, delta: 2, level: "house" },
      { type: "building_changed", tile: 7, houses: 1, delta: -2, level: "house" },
    );
    expect(squareFacts(facts, 7).houses).toBe(1);
  });

  it("says nothing about who owns the square it built on", () => {
    // `BuildingChanged` carries no player, so a replay that has only seen this event knows houses
    // stand there and does not know whose they are.
    const facts = fold({ type: "building_changed", tile: 7, houses: 1, delta: 1, level: "house" });
    expect(squareFacts(facts, 7).houses).toBe(1);
    expect(squareFacts(facts, 7).owner).toBeUndefined();
  });
});

describe("mortgage_changed", () => {
  it("copies the flag both ways", () => {
    const on = fold({ type: "mortgage_changed", player: 0, tile: 7, mortgaged: true });
    expect(squareFacts(on, 7).mortgaged).toBe(true);
    const off = fold(
      { type: "mortgage_changed", player: 0, tile: 7, mortgaged: true },
      { type: "mortgage_changed", player: 0, tile: 7, mortgaged: false },
    );
    expect(squareFacts(off, 7).mortgaged).toBe(false);
  });
});

describe("jail", () => {
  it("flags the seat without moving its token", () => {
    // `SentToJail` carries no tile. The trip to the jail square arrives as its own `token_moved`,
    // and inventing "jail is square 10" here would be board data hardcoded in a viewer.
    const facts = fold({ type: "sent_to_jail", player: 1, via: "three_doubles" });
    expect(seatFacts(facts, 1).inJail).toBe(true);
    expect(seatFacts(facts, 1).position).toBeUndefined();
  });

  it("clears the flag on release", () => {
    const facts = fold(
      { type: "sent_to_jail", player: 1, via: "tile" },
      { type: "left_jail", player: 1, via: "fine" },
    );
    expect(seatFacts(facts, 1).inJail).toBe(false);
  });
});

describe("trade_executed", () => {
  const offer: EventOfType<"trade_executed">["offer"] = {
    proposer: 0,
    recipient: 1,
    give: { cash: 50, tiles: [7, 9], jail_cards: [] },
    receive: { cash: 0, tiles: [12], jail_cards: [] },
  };

  it("moves each side's squares to the party that received them", () => {
    const facts = fold({ type: "trade_executed", offer });
    // `give` is what the proposer handed over, so those are the recipient's now…
    expect(squareFacts(facts, 7).owner).toBe(1);
    expect(squareFacts(facts, 9).owner).toBe(1);
    // …and `receive` is what came back the other way.
    expect(squareFacts(facts, 12).owner).toBe(0);
  });

  it("ignores the cash in the offer", () => {
    // The offer states an *amount*; the balances it produced are on the `cash_changed` events the
    // same command emitted. Reading both would be two sources for one number.
    const facts = fold({ type: "trade_executed", offer });
    expect(seatFacts(facts, 0).cash).toBeUndefined();
    expect(seatFacts(facts, 1).cash).toBeUndefined();
  });
});

describe("player_bankrupted", () => {
  const base: EventOfType<"player_bankrupted"> = {
    type: "player_bankrupted",
    player: 1,
    creditor: 0,
    tiles_transferred: [7, 9],
    cash_transferred: 240,
    jail_cards_transferred: [],
    shares: [],
  };

  it("marks the seat out and credits the whole estate to the single creditor", () => {
    const facts = fold(base);
    expect(seatFacts(facts, 1).bankrupt).toBe(true);
    expect(squareFacts(facts, 7).owner).toBe(0);
    expect(squareFacts(facts, 9).owner).toBe(0);
  });

  it("returns squares to the bank as unowned when the creditor is the bank", () => {
    const facts = fold({ ...base, creditor: "bank" });
    expect(squareFacts(facts, 7).owner).toBeNull();
  });

  it("divides a multi-creditor estate by the shares rather than by the principal", () => {
    // The event names one `creditor` — the principal — *and* a share per claimant. Reading the
    // principal alone would hand one player squares the event says went to another.
    const facts = fold({
      ...base,
      creditor: 0,
      tiles_transferred: [7, 9, 12],
      shares: [
        { creditor: 0, claim: 300, cash: 100, tiles: [7], jail_cards: [] },
        { creditor: 2, claim: 200, cash: 60, tiles: [9], jail_cards: [] },
        { creditor: "bank", claim: 100, cash: 0, tiles: [12], jail_cards: [] },
      ],
    });
    expect(squareFacts(facts, 7).owner).toBe(0);
    expect(squareFacts(facts, 9).owner).toBe(2);
    expect(squareFacts(facts, 12).owner).toBeNull();
  });

  it("does not read the cash that came with the estate", () => {
    expect(seatFacts(fold(base), 0).cash).toBeUndefined();
  });
});

describe("game_ended", () => {
  it("states the winner and that the game is over", () => {
    const facts = fold({
      type: "game_ended",
      winner: 1,
      reason: "last_solvent",
      final_standings: [],
    });
    expect(facts.winner).toBe(1);
    expect(facts.finished).toBe(true);
  });

  it("keeps a winnerless ending distinguishable from an unfinished game", () => {
    // `null` is "the game ended with nobody left standing"; `undefined` is "no `game_ended` yet".
    // Collapsing the two would make a viewer of an abandoned game claim it had ended.
    const ended = fold({
      type: "game_ended",
      winner: null,
      reason: "no_survivors",
      final_standings: [],
    });
    expect(ended.winner).toBeNull();
    expect(ended.finished).toBe(true);
    expect(fold(TURN_1).winner).toBeUndefined();
    expect(fold(TURN_1).finished).toBe(false);
  });
});

describe("the event types that state nothing", () => {
  /**
   * One instance of each silent type, spelled out so the assertion runs against a real payload.
   *
   * `Record<…, GameEvent>` over the listed keys rather than a bare array: the union is checked, so a
   * payload that drifts from the wire shape is a compile error here too.
   */
  const SILENT: Readonly<Record<string, GameEvent>> = {
    rent_charged: {
      type: "rent_charged",
      payer: 1,
      owner: 0,
      tile: 7,
      amount: 24,
      base_rent: 6,
      houses: 0,
      multiplier: 4,
      dice_total: null,
      note_keys: [],
      note_params: {},
    },
    auction_started: {
      type: "auction_started",
      lot: { kind: "tile", tile: 7 },
      reason: "declined_purchase",
      eligible: [0, 1],
    },
    bid_placed: { type: "bid_placed", player: 0, amount: 70 },
    bidder_withdrew: { type: "bidder_withdrew", player: 1 },
    auction_ended: { type: "auction_ended", lot: { kind: "tile", tile: 7 }, winner: 0, price: 70 },
    card_drawn: {
      type: "card_drawn",
      player: 0,
      deck: "chance",
      card_id: "advance_to_go",
    },
    trade_proposed: {
      type: "trade_proposed",
      offer: {
        proposer: 0,
        recipient: 1,
        give: { cash: 0, tiles: [], jail_cards: [] },
        receive: { cash: 0, tiles: [], jail_cards: [] },
      },
    },
    trade_declined: {
      type: "trade_declined",
      offer: {
        proposer: 0,
        recipient: 1,
        give: { cash: 0, tiles: [], jail_cards: [] },
        receive: { cash: 0, tiles: [], jail_cards: [] },
      },
    },
    trade_cancelled: {
      type: "trade_cancelled",
      by: "proposer",
      offer: {
        proposer: 0,
        recipient: 1,
        give: { cash: 0, tiles: [], jail_cards: [] },
        receive: { cash: 0, tiles: [], jail_cards: [] },
      },
    },
    debt_incurred: { type: "debt_incurred", debtor: 1, creditor: 0, amount: 240 },
    debt_settled: { type: "debt_settled", debtor: 1, creditor: 0, amount: 240 },
    phase_changed: { type: "phase_changed", previous: "awaiting_roll", current: "resolving_tile" },
  };

  it.each(Object.entries(SILENT))("%s changes nothing but the position", (_type, event) => {
    // Folded onto a frame that already knows things, so a folder that *cleared* a fact would fail
    // here rather than passing against an empty starting value.
    const before = fold(TURN_1, ROLLED, MOVED, PAID, BOUGHT);
    const after = foldEvent(before, loggedEvent(before.seq + 1, event));

    expect({ ...after, applied: before.applied, seq: before.seq }).toEqual(before);
    expect(after.applied).toBe(before.applied + 1);
    expect(after.seq).toBe(before.seq + 1);
  });

  it("covers every silent type the table declares", () => {
    // The counterpart to the compiler's exhaustiveness check: this list is hand-written, so it can
    // fall behind the table. The count is the tripwire — a new silent event type makes this fail
    // until it has an instance above and therefore an assertion behind it.
    const declared: readonly GameEventType[] = [
      "rent_charged",
      "auction_started",
      "bid_placed",
      "bidder_withdrew",
      "auction_ended",
      "card_drawn",
      "trade_proposed",
      "trade_declined",
      "trade_cancelled",
      "debt_incurred",
      "debt_settled",
      "phase_changed",
    ];
    expect(Object.keys(SILENT).sort()).toEqual([...declared].sort());
  });
});

describe("factsAt", () => {
  const LOG: readonly LoggedEvent[] = [
    loggedEvent(1, TURN_1),
    loggedEvent(2, ROLLED),
    loggedEvent(3, MOVED),
    loggedEvent(4, PAID),
    loggedEvent(5, BOUGHT),
  ];

  it("shows only what had happened by that position", () => {
    const midway = factsAt(LOG, 3);
    expect(midway.applied).toBe(3);
    expect(midway.seq).toBe(3);
    expect(seatFacts(midway, 0).position).toBe(7);
    // The purchase is two events away and has not happened yet.
    expect(seatFacts(midway, 0).cash).toBeUndefined();
    expect(squareFacts(midway, 7).owner).toBeUndefined();
  });

  it("is the same value walked forwards or jumped to", () => {
    // The property that makes scrubbing trustworthy: there is one code path, and it runs forwards.
    const stepped = LOG.slice(0, 4).reduce(foldEvent, NOTHING_STATED);
    expect(factsAt(LOG, 4)).toEqual(stepped);
  });

  it("clamps a position outside the log", () => {
    expect(factsAt(LOG, -3)).toEqual(NOTHING_STATED);
    expect(factsAt(LOG, 99)).toEqual(factsAt(LOG, LOG.length));
  });

  it("counts positions, not facts", () => {
    // Position 5 of a five-event log is the end of it even though two of the five stated nothing
    // about the table. The slider and the log have to agree on what "5" means.
    const withSilence: readonly LoggedEvent[] = [
      loggedEvent(1, TURN_1),
      loggedEvent(2, {
        type: "phase_changed",
        previous: "awaiting_roll",
        current: "resolving_tile",
      }),
      loggedEvent(3, MOVED),
    ];
    expect(factsAt(withSilence, 3).applied).toBe(3);
    expect(factsAt(withSilence, 3).seq).toBe(3);
  });
});
