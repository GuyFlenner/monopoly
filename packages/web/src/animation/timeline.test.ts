/**
 * The timeline, and the tests that have to be able to fail.
 *
 * ## The falsifiers
 *
 * Most of MON-701's acceptance criteria can be satisfied by an implementation that just plays every
 * event in order, and a test fed a *short* batch cannot tell that apart from one that compresses. So
 * the central tests here feed batches that are deliberately over budget and assert on what
 * *survived*:
 *
 * - A thirty-seven-square move walks thirty-seven squares when it is the only thing in the batch, and
 *   collapses to a single glide when it is not. Delete `compress` and the second one goes red.
 * - Six bot turns' worth of rolls produce **one** dice settle. Remove the supersession rule and the
 *   count is six.
 * - A move is *never* superseded, even when a later move by the same player follows a payment.
 *   Widen the supersession rule to cover moves and that test goes red, because the piece would skip
 *   the square it stopped on.
 * - `instant` produces a timeline with the same *steps* and zero durations, not an empty one. Return
 *   `[]` for reduced motion — the obvious shortcut — and the board never updates its token
 *   positions at all, which is the bug that shortcut would ship.
 */

import { describe, expect, it } from "vitest";

import type { LoggedEvent } from "@/api";
import { TILE_COUNT } from "@/board";

import {
  cardFigure,
  compress,
  DEFAULT_BUDGET_MS,
  DEFAULT_DURATIONS,
  destinationOf,
  instantly,
  plan,
  readingAllowanceMs,
  stepFor,
  totalMs,
  walk,
  type CardRevealStep,
  type TimelineStep,
  type TokenMoveStep,
} from "./timeline";

let nextSeq = 1;

function frame(event: LoggedEvent["event"], seq?: number): LoggedEvent {
  const assigned = seq ?? nextSeq;
  nextSeq = assigned + 1;
  return { seq: assigned, event };
}

function moved(
  player: number,
  from: number,
  to: number,
  extras: { readonly forward?: boolean; readonly passed_go?: boolean } = {},
): LoggedEvent {
  return frame({
    type: "token_moved",
    player,
    from_tile: from,
    to_tile: to,
    forward: extras.forward ?? true,
    passed_go: extras.passed_go ?? false,
  });
}

function rolled(player: number, first = 3, second = 4): LoggedEvent {
  return frame({
    type: "dice_rolled",
    player,
    first,
    second,
    total: first + second,
    doubles_streak: 0,
    purpose: "move",
  });
}

function cash(player: number, delta: number): LoggedEvent {
  return frame({
    type: "cash_changed",
    player,
    delta,
    reason: "rent",
    balance: 1500 + delta,
    counterparty: "bank",
  });
}

function built(tile: number, houses: number, delta = 1): LoggedEvent {
  return frame({ type: "building_changed", tile, houses, delta, level: "house" });
}

/** An event nothing animates, so a batch can be checked for what it *leaves* still. */
function mortgaged(tile: number): LoggedEvent {
  return frame({ type: "mortgage_changed", tile, player: 1, mortgaged: true });
}

function drew(
  player: number,
  cardId = "card.chance.advance_to_go",
  deck: "chance" | "community_chest" = "chance",
): LoggedEvent {
  return frame({ type: "card_drawn", player, deck, card_id: cardId });
}

/** A cash change with a stated reason, which is what tells a card's own money from money it led to. */
function paid(
  player: number,
  delta: number,
  reason: "card" | "go_salary" | "rent" | "tax",
): LoggedEvent {
  return frame({
    type: "cash_changed",
    player,
    delta,
    reason,
    balance: 1500 + delta,
    counterparty: "bank",
  });
}

function cards(steps: readonly TimelineStep[]): readonly CardRevealStep[] {
  return steps.filter((step): step is CardRevealStep => step.kind === "card_reveal");
}

function kinds(steps: readonly TimelineStep[]): readonly string[] {
  return steps.map((step) => step.kind);
}

function moves(steps: readonly TimelineStep[]): readonly TokenMoveStep[] {
  return steps.filter((step): step is TokenMoveStep => step.kind === "token_move");
}

describe("walking the ring", () => {
  it("counts the squares crossed, excluding the one left and including the one landed on", () => {
    expect(walk(5, 9, true)).toEqual([6, 7, 8, 9]);
  });

  it("wraps past GO", () => {
    expect(walk(38, 2, true)).toEqual([39, 0, 1, 2]);
  });

  it("goes the short way backwards when the event says backwards, not the long way round", () => {
    // The endpoints alone cannot tell "back three" from "forward thirty-seven", which is why
    // `TokenMoved.forward` exists and why this module never infers the direction.
    expect(walk(5, 2, false)).toEqual([4, 3, 2]);
    expect(walk(5, 2, true)).toHaveLength(TILE_COUNT - 3);
  });

  it("degrades to a single hop for an index the ring does not contain", () => {
    // A missed flourish, rather than a walk that never arrives. `walk` is the only thing between a
    // malformed frame and a board that hangs on an animation.
    expect(walk(-1, 4, true)).toEqual([4]);
    expect(walk(3, 99, true)).toEqual([99]);
  });

  it("treats a move that did not move as one terminal position", () => {
    expect(walk(7, 7, true)).toEqual([7]);
  });
});

describe("one event, at most one beat", () => {
  it("maps the four MON-701 events and nothing else", () => {
    expect(stepFor(moved(1, 0, 3), DEFAULT_DURATIONS)?.kind).toBe("token_move");
    expect(stepFor(rolled(1), DEFAULT_DURATIONS)?.kind).toBe("dice_settle");
    expect(stepFor(cash(1, -50), DEFAULT_DURATIONS)?.kind).toBe("cash_pulse");
    expect(stepFor(built(3, 1), DEFAULT_DURATIONS)?.kind).toBe("building_pop");
    expect(stepFor(mortgaged(3), DEFAULT_DURATIONS)).toBeNull();
  });

  it("leaves a rent charge to the cash movement it comes with, so a payment pulses once", () => {
    // `rent_charged` and its `cash_changed` are two events for one thing that happened. The rule is
    // one beat per thing, and this is the specific place a second beat would be added.
    const steps = plan([
      frame({
        type: "rent_charged",
        payer: 1,
        owner: 2,
        tile: 6,
        amount: 50,
        base_rent: 50,
        houses: 0,
        multiplier: 1,
        note_keys: [],
        note_params: {},
      }),
      cash(1, -50),
    ]);
    expect(kinds(steps)).toEqual(["cash_pulse"]);
  });

  it("is still for a zero delta — an animation for nothing happening is a lie", () => {
    expect(stepFor(cash(1, 0), DEFAULT_DURATIONS)).toBeNull();
  });

  it("prices a move by the squares it crosses", () => {
    const step = stepFor(moved(1, 0, 7), DEFAULT_DURATIONS);
    expect(step?.durationMs).toBe(DEFAULT_DURATIONS.perTileMs * 7);
  });
});

describe("ordering", () => {
  it("keeps the order the events happened in", () => {
    const steps = plan([rolled(1), moved(1, 0, 4), cash(1, -50), built(4, 1)]);
    expect(kinds(steps)).toEqual(["dice_settle", "token_move", "cash_pulse", "building_pop"]);
  });

  it("carries each step's originating seq, so a step can be traced to its event", () => {
    const steps = plan([rolled(1, 1, 1), built(9, 2)]);
    expect(steps.map((step) => step.seq)).toEqual([steps[0]?.seq, steps[1]?.seq]);
    expect(steps[1]?.seq).toBeGreaterThan(steps[0]?.seq ?? 0);
  });
});

describe("coalescing: adjacent legs of one journey", () => {
  it("folds two consecutive moves by the same player into one walk that keeps every square", () => {
    const steps = plan([moved(1, 0, 3), moved(1, 3, 6)]);
    const [journey] = moves(steps);
    expect(steps).toHaveLength(1);
    expect(journey?.path).toEqual([1, 2, 3, 4, 5, 6]);
    expect(journey?.from).toBe(0);
    expect(destinationOf(journey as TokenMoveStep)).toBe(6);
  });

  it("does not fold across an event that happened in between", () => {
    // A move, a payment and another move are three things. Folding the moves would hide the
    // payment's beat between them.
    const steps = plan([moved(1, 0, 3), cash(1, -50), moved(1, 3, 6)]);
    expect(kinds(steps)).toEqual(["token_move", "cash_pulse", "token_move"]);
  });

  it("does not fold two different players' moves", () => {
    const steps = plan([moved(1, 0, 3), moved(2, 10, 12)]);
    expect(moves(steps)).toHaveLength(2);
  });
});

describe("the compression ladder", () => {
  it("plays a long move square by square when it is the only thing in the batch", () => {
    const steps = plan([moved(1, 0, 12)]);
    expect(moves(steps)[0]?.path).toHaveLength(12);
  });

  it("collapses intermediate positions once the batch is over budget", () => {
    // A bot's whole turn arriving at once. Without `compress` this is 30-plus seconds of travel;
    // with it, one glide per leg that still lands on the right square.
    const burst = [
      rolled(1),
      moved(1, 0, 37),
      cash(1, -200),
      rolled(2),
      moved(2, 0, 33),
      cash(2, -150),
    ];
    const steps = plan(burst);
    expect(totalMs(steps)).toBeLessThanOrEqual(DEFAULT_BUDGET_MS);
    for (const step of moves(steps)) {
      expect(step.path).toHaveLength(1);
    }
    expect(moves(steps).map(destinationOf)).toEqual([37, 33]);
  });

  it("keeps one dice settle out of six, not six", () => {
    const burst = [1, 2, 3, 4, 5, 6].flatMap((seat) => [rolled(seat), moved(seat, 0, 20)]);
    const steps = plan(burst);
    expect(kinds(steps).filter((kind) => kind === "dice_settle")).toHaveLength(1);
  });

  it("keeps the last cash beat per player and the last pop per square", () => {
    const steps = compress([
      ...plan([cash(1, 100)]),
      ...plan([cash(1, -50)]),
      ...plan([cash(2, -50)]),
      ...plan([built(6, 1)]),
      ...plan([built(6, 2)]),
      ...plan([built(8, 1)]),
    ]);
    expect(kinds(steps)).toEqual(["cash_pulse", "cash_pulse", "building_pop", "building_pop"]);
    // The survivor is the *later* one: the fact a beat shows became true at its last occurrence.
    const pops = steps.filter(
      (step): step is Extract<TimelineStep, { kind: "building_pop" }> =>
        step.kind === "building_pop",
    );
    expect(pops.map((step) => step.houses)).toEqual([2, 1]);
  });

  it("never supersedes a move, because every leg is a square the piece stopped on", () => {
    const steps = compress([...plan([moved(1, 0, 3)]), ...plan([moved(1, 10, 14)])]);
    expect(moves(steps).map(destinationOf)).toEqual([3, 14]);
  });

  it("falls to zero durations when even the compressed timeline cannot fit", () => {
    // Sixty seats' worth of distinct payments: nothing left to supersede and nothing left to
    // shorten, so the honest answer is to stop taking time rather than to drop what happened.
    const many = Array.from({ length: 60 }, (_, seat) => cash(seat, -10));
    const steps = plan(many);
    expect(steps).toHaveLength(60);
    expect(totalMs(steps)).toBe(0);
  });
});

/**
 * The card (MON-709). Every claim here is about a figure this module must **not** work out.
 *
 * The falsifiers: a card that took the next payment whatever its reason would print "you paid $200"
 * on a card that says nothing of the sort; a card that took a rival's payment would show +50 on
 * "pay every other player $50"; and a card that survived compression only by being shortened would
 * be flashed for a fifth of a second, which is not a faster read but an unread card.
 */
describe("a drawn card", () => {
  it("carries the engine's own catalogue key, and no text of its own", () => {
    const [card] = cards(plan([drew(1, "card.chest.doctors_fee")]));
    expect(card?.cardId).toBe("card.chest.doctors_fee");
    expect(card?.player).toBe(1);
    expect(card?.durationMs).toBe(DEFAULT_DURATIONS.cardMs);
  });

  it("shows the figure the engine attributed to the card", () => {
    const [card] = cards(plan([drew(1), paid(1, -50, "card")]));
    expect(card?.delta).toBe(-50);
    expect(card?.balance).toBe(1450);
  });

  it("shows no figure for money the card merely led to", () => {
    // "Advance to GO" pays a salary; the salary is not what the card says, and `reason` is how the
    // engine already tells the two apart. Drop the `reason` check and this reads "+200".
    const [card] = cards(plan([drew(1), paid(1, 200, "go_salary")]));
    expect(card?.delta).toBeNull();
    expect(card?.balance).toBeNull();
  });

  it("shows the drawer's side of a card that moves other players' money", () => {
    // "You are elected chairman — pay every other player $50."
    const [card] = cards(plan([drew(1), paid(2, 50, "card"), paid(1, -150, "card")]));
    expect(card?.delta).toBe(-150);
  });

  it("never reaches across a later draw or a new turn for a figure", () => {
    const later = [
      drew(1),
      frame({ type: "card_drawn", player: 1, deck: "community_chest", card_id: "card.chest.gift" }),
      paid(1, 25, "card"),
    ];
    // Planned with room, because the claim is about *which payment a card claims* and a compressed
    // batch drops the superseded card — at which point `cards(...)[0]` would be the second card and
    // the assertion would be reading the wrong beat. Two cards at the default dwell exceed the budget
    // since MON-719 raised it, so this has to be said rather than assumed.
    expect(cards(plan(later, { budgetMs: 60_000 }))[0]?.delta).toBeNull();

    const nextTurn: readonly LoggedEvent[] = [
      { seq: 90, event: { type: "card_drawn", player: 1, deck: "chance", card_id: "card.x" } },
      { seq: 91, event: { type: "turn_started", player: 2, turn_number: 9 } },
      {
        seq: 92,
        event: {
          type: "cash_changed",
          player: 1,
          delta: 25,
          reason: "card",
          balance: 1525,
          counterparty: "bank",
        },
      },
    ];
    expect(cardFigure(1, nextTurn.slice(1))).toBeNull();
  });

  it("grants one card's reading time however many cards are in the batch", () => {
    const one = plan([drew(1)]);
    expect(readingAllowanceMs(one)).toBe(DEFAULT_DURATIONS.cardMs);
    // Six draws are 10.8s of overlay; the grant must not grow with them or the cap is not a cap.
    const six = Array.from({ length: 6 }, (_, seat) => drew(seat));
    expect(readingAllowanceMs(six.flatMap((event) => [...plan([event])]))).toBe(
      DEFAULT_DURATIONS.cardMs,
    );
  });

  it("does not spend a token's walk on a card's dwell", () => {
    // Roll, seven squares, card, payment — over budget on the raw arithmetic, and it is precisely the
    // turn where the walk carries information, because a card is what sends a player past GO. Remove
    // the reading allowance from `plan` and the walk collapses to one glide.
    const steps = plan([rolled(1), moved(1, 0, 7), drew(1), paid(1, -50, "card")]);
    expect(totalMs(steps)).toBeGreaterThan(DEFAULT_BUDGET_MS);
    expect(moves(steps)[0]?.path).toHaveLength(7);
  });

  it("drops the cards a later card replaced, and holds the survivor for its full time", () => {
    const steps = compress([
      ...plan([drew(1, "card.chance.first")]),
      ...plan([drew(2, "card.chance.second")]),
      ...plan([drew(3, "card.chance.third")]),
    ]);
    const survivors = cards(steps);
    expect(survivors).toHaveLength(1);
    // The last one, at its full dwell: half a sentence is not a faster read.
    expect(survivors[0]?.cardId).toBe("card.chance.third");
    expect(survivors[0]?.durationMs).toBe(DEFAULT_DURATIONS.cardMs);
  });

  it("contends for one surface across players and decks, not one per deck", () => {
    const steps = compress([
      ...plan([drew(1, "card.chance.a", "chance")]),
      ...plan([drew(2, "card.chest.b", "community_chest")]),
    ]);
    expect(cards(steps)).toHaveLength(1);
  });
});

describe("reduced motion", () => {
  it("keeps every step and zeroes every duration", () => {
    // Not `[]`. An empty timeline would never move a token override off its old square, so the
    // board would keep drawing a stale position — the exact bug the "obvious" shortcut ships.
    const events = [rolled(1), moved(1, 0, 5), cash(1, -50), built(5, 1)];
    const steps = plan(events, { instant: true });
    expect(kinds(steps)).toEqual(kinds(plan(events)));
    expect(totalMs(steps)).toBe(0);
  });

  it("is idempotent, and leaves an already-instant step alone", () => {
    const once = instantly(plan([moved(1, 0, 4)]));
    expect(instantly(once)).toEqual(once);
  });

  it("still merges adjacent legs, so the piece lands in one place rather than two", () => {
    const steps = plan([moved(1, 0, 3), moved(1, 3, 6)], { instant: true });
    expect(steps).toHaveLength(1);
    expect(destinationOf(moves(steps)[0] as TokenMoveStep)).toBe(6);
  });

  it("still holds the card up long enough to read (MON-709)", () => {
    // Reduced motion, not reduced information. The card does not move — its entrance is zero through
    // `useMotionPreference` — but the log names only the deck, so a zeroed card is an instruction the
    // player is about to be held to that appeared nowhere. Zero `cardMs` here and a player who asked
    // for a still board is left guessing.
    const steps = plan([rolled(1), moved(1, 0, 5), drew(1), paid(1, -50, "card")], {
      instant: true,
    });
    expect(cards(steps)).toHaveLength(1);
    expect(cards(steps)[0]?.durationMs).toBe(DEFAULT_DURATIONS.cardMs);
    // Everything else really is still.
    expect(totalMs(steps.filter((step) => step.kind !== "card_reveal"))).toBe(0);
  });
});

describe("frames that are history", () => {
  it("holds up no card at all — nobody watched that draw happen", () => {
    // A reload replays the whole game in one batch. Reduced motion's answer (keep the dwell) would
    // put up a card someone drew twenty turns ago, and forty of them in a row.
    const steps = plan([rolled(1), moved(1, 0, 5), drew(1), paid(1, -50, "card")], {
      instant: true,
      history: true,
    });
    expect(cards(steps)).toHaveLength(0);
    expect(totalMs(steps)).toBe(0);
    // The rest of the batch still lands, or the board would keep drawing a stale position.
    expect(kinds(steps)).toEqual(["dice_settle", "token_move", "cash_pulse"]);
  });
});
