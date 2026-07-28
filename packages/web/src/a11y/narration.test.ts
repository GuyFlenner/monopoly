import { describe, expect, it } from "vitest";

import type { GameEvent, Phase } from "@/api";

import { INTERRUPT_PHASE_KEYS, narrate, type NarrationContext } from "./narration";

/**
 * The mapping is pure, so it is tested pure. What can break: a sentence going to the wrong
 * region (the dice interrupting a listener every twenty seconds), an event producing two
 * announcements where it should produce one, and a param that stops matching its catalogue
 * placeholder — which renders a literal `{{amount}}` to a child.
 */

const context: NarrationContext = {
  playerName: (id) => ["Ruti", "Dan"][id] ?? `#${String(id)}`,
  tileName: (index) => `tile-${String(index)}`,
};

function narrateOne(event: GameEvent): ReturnType<typeof narrate> {
  return narrate(event, context);
}

describe("narrate", () => {
  it("sends a turn change to the assertive region — the acting player changed", () => {
    expect(narrateOne({ type: "turn_started", player: 1, turn_number: 4 })).toEqual([
      { politeness: "assertive", key: "a11y.turn", params: { name: "Dan" } },
    ]);
  });

  it("sends the dice to the polite region, carrying the server's own total", () => {
    expect(
      narrateOne({
        type: "dice_rolled",
        player: 0,
        first: 4,
        second: 3,
        total: 7,
        doubles_streak: 0,
        purpose: "move",
      }),
    ).toEqual([
      { politeness: "polite", key: "a11y.diceResult", params: { first: 4, second: 3, total: 7 } },
    ]);
  });

  it("announces passing GO before arriving, and never invents the salary", () => {
    const drafts = narrateOne({
      type: "token_moved",
      player: 0,
      from_tile: 38,
      to_tile: 3,
      forward: true,
      passed_go: true,
    });

    expect(drafts.map((draft) => draft.key)).toEqual(["a11y.passed_go", "a11y.moved"]);
    // `TokenMoved` carries no amount, so neither does the sentence — the GO salary is its own
    // `CashChanged` and is announced there.
    expect(drafts[0]?.params).toEqual({ name: "Ruti" });
    expect(drafts[1]?.params).toEqual({ name: "Ruti", tile: "tile-3" });
  });

  it("says nothing about GO on an ordinary move", () => {
    const drafts = narrateOne({
      type: "token_moved",
      player: 0,
      from_tile: 1,
      to_tile: 3,
      forward: true,
      passed_go: false,
    });

    expect(drafts.map((draft) => draft.key)).toEqual(["a11y.moved"]);
  });

  it("picks the verb from the sign of the delta and reports the magnitude", () => {
    const gained = narrateOne({
      type: "cash_changed",
      player: 0,
      delta: 200,
      reason: "go_salary",
      balance: 1700,
      counterparty: "bank",
    });
    const paid = narrateOne({
      type: "cash_changed",
      player: 1,
      delta: -50,
      reason: "rent",
      balance: 1450,
      counterparty: 0,
    });

    expect(gained).toEqual([
      { politeness: "polite", key: "a11y.cash_gained", params: { name: "Ruti", amount: 200 } },
    ]);
    // The sentence says "paid 50", not "paid -50".
    expect(paid).toEqual([
      { politeness: "polite", key: "a11y.cash_paid", params: { name: "Dan", amount: 50 } },
    ]);
  });

  it("says nothing when no money actually moved", () => {
    expect(
      narrateOne({
        type: "cash_changed",
        player: 0,
        delta: 0,
        reason: "trade",
        balance: 1500,
        counterparty: "bank",
      }),
    ).toEqual([]);
  });

  it("names both sides of a rent payment and uses the amount the engine charged", () => {
    expect(
      narrateOne({
        type: "rent_charged",
        payer: 1,
        owner: 0,
        tile: 6,
        amount: 60,
        base_rent: 30,
        houses: 0,
        multiplier: 2,
        note_keys: ["rent.note.full_group_doubled"],
      }),
    ).toEqual([
      {
        politeness: "polite",
        key: "a11y.rent_charged",
        // 60, not base_rent × multiplier: the client does not do rent maths, even when it
        // happens to have all the factors in front of it.
        params: { payer: "Dan", owner: "Ruti", amount: 60 },
      },
    ]);
  });

  it.each(["auction", "debt_settlement", "trade_review"] satisfies Phase[])(
    "interrupts assertively when the table moves to %s",
    (phase) => {
      const drafts = narrateOne({
        type: "phase_changed",
        previous: "awaiting_roll",
        current: phase,
      });

      expect(drafts).toHaveLength(1);
      expect(drafts[0]?.politeness).toBe("assertive");
      expect(drafts[0]?.key).toBe(INTERRUPT_PHASE_KEYS[phase]);
    },
  );

  it("stays quiet on an ordinary phase change — the events already said what happened", () => {
    expect(
      narrateOne({ type: "phase_changed", previous: "moving", current: "awaiting_end_turn" }),
    ).toEqual([]);
  });

  it("stays quiet on an event with no sentence yet, rather than reading out its type", () => {
    expect(narrateOne({ type: "mortgage_changed", tile: 6, mortgaged: true })).toEqual([]);
  });

  it("covers exactly the three phases in which the acting player may not be the turn holder", () => {
    expect(Object.keys(INTERRUPT_PHASE_KEYS).sort()).toEqual([
      "auction",
      "debt_settlement",
      "trade_review",
    ]);
  });
});
