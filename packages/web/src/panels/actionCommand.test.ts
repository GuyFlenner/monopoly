/**
 * The coverage gate on command → catalogue key.
 *
 * The failure this file exists to prevent is a new engine command landing and the ActionBar
 * printing a raw `build_house` at a six-year-old. `ActionLabels.test.ts` guarded that with a
 * hand-written map behind it; the map is gone, so what needs guarding has changed shape:
 *
 * 1. Every key the resolver can emit **exists in the catalogue**. Concatenation cannot produce a
 *    typo, but it can produce a key nobody wrote — a new command kind resolves to
 *    `action.<kind>` whether or not a leaf exists, and `missingKeyHandler` throws and takes the
 *    whole bar down (deliberately, GAP G-F17), not just the one button.
 * 2. Every placeholder a label declares is supplied. This is the trap the old suite was really
 *    about: `action.buy` wanted `{{price}}` and nothing on the wire could give it one, which is
 *    why the price-free `action.buy_property` exists and `action.buy` was deleted.
 * 3. The two payload variants stay distinguishable. Accepting and declining a trade must not
 *    share a label.
 *
 * What is deliberately *not* tested any more: that the key for a kind is spelled a particular way.
 * `baseLabelKey` is one concatenation, and a test asserting `action.roll_dice === "action." +
 * "roll_dice"` restates the implementation instead of constraining it.
 */

import { describe, expect, it } from "vitest";

import type { Command, CommandKind } from "@/api";
import commonEn from "@/i18n/locales/common.en.json";
import { COMMAND_KINDS, TERMINAL_COMMANDS, requiresConfirmation } from "@/theme";

import {
  baseLabelKey,
  consequenceKeyFor,
  labelKeyFor,
  labelKeysFor,
  labelParamsFor,
  NO_AUCTION_SUFFIX,
  tileOf,
} from "./actionCommand";

/** The English catalogue as dotted keys, which is how the resolver spells them. */
function flatten(payload: unknown, prefix = ""): Map<string, string> {
  const flat = new Map<string, string>();
  if (typeof payload !== "object" || payload === null) {
    return flat;
  }
  for (const [key, value] of Object.entries(payload)) {
    const path = `${prefix}${key}`;
    if (typeof value === "string") {
      flat.set(path, value);
    } else {
      for (const [nested, leaf] of flatten(value, `${path}.`)) {
        flat.set(nested, leaf);
      }
    }
  }
  return flat;
}

const CATALOGUE = flatten(commonEn);

function placeholdersIn(value: string): readonly string[] {
  return [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] ?? "");
}

const EMPTY_OFFER = {
  proposer: 0,
  recipient: 1,
  give: { cash: 0, tiles: [], jail_cards: [] },
  receive: { cash: 0, tiles: [], jail_cards: [] },
};

/**
 * One command per kind, so the placeholder check can walk the whole union.
 *
 * `Record<CommandKind, Command>` rather than an array: a kind added to the contract fails to
 * compile here, which is the same gate `ACTION_THEME` uses and for the same reason.
 */
const SAMPLE: Readonly<Record<CommandKind, Command>> = {
  roll_dice: { kind: "roll_dice", player: 0 },
  end_turn: { kind: "end_turn", player: 0, elapsed_seconds: null },
  buy_property: { kind: "buy_property", player: 0 },
  decline_purchase: { kind: "decline_purchase", player: 0 },
  place_bid: { kind: "place_bid", player: 0, amount: 120 },
  withdraw_from_auction: { kind: "withdraw_from_auction", player: 0 },
  build_house: { kind: "build_house", player: 0, tile: 1 },
  sell_house: { kind: "sell_house", player: 0, tile: 1, demolish_hotel: false },
  mortgage_property: { kind: "mortgage_property", player: 0, tile: 1 },
  unmortgage_property: { kind: "unmortgage_property", player: 0, tile: 1 },
  propose_trade: { kind: "propose_trade", player: 0, offer: EMPTY_OFFER },
  respond_to_trade: { kind: "respond_to_trade", player: 0, accept: true },
  cancel_trade: { kind: "cancel_trade", player: 0 },
  pay_jail_fine: { kind: "pay_jail_fine", player: 0 },
  use_jail_card: { kind: "use_jail_card", player: 0 },
  roll_for_jail: { kind: "roll_for_jail", player: 0 },
  declare_bankruptcy: { kind: "declare_bankruptcy", player: 0 },
};

const JAIL_FINE = 50;

describe("label keys", () => {
  it("resolves every key it can emit against the English catalogue", () => {
    const unresolvable: string[] = [];
    for (const kind of COMMAND_KINDS) {
      for (const key of labelKeysFor(kind)) {
        if (!CATALOGUE.has(key)) {
          unresolvable.push(`${kind} -> ${key}`);
        }
      }
    }
    expect(unresolvable, "label keys that resolve to nothing").toEqual([]);
  });

  it("supplies every placeholder its label declares", () => {
    const unsupplied: string[] = [];
    for (const kind of COMMAND_KINDS) {
      const command = SAMPLE[kind];
      const params = labelParamsFor(command, JAIL_FINE);
      for (const key of labelKeysFor(kind)) {
        for (const placeholder of placeholdersIn(CATALOGUE.get(key) ?? "")) {
          if (!(placeholder in params)) {
            unsupplied.push(`${key} wants {{${placeholder}}}`);
          }
        }
      }
    }
    expect(unsupplied, "labels with a placeholder nothing fills").toEqual([]);
  });

  it("gives a command with no variant exactly one key, and that key is the base", () => {
    // The property ADR-003 §6 bought. Asserted on a kind with no payload variant, so it is a claim
    // about derivability rather than a restatement of the concatenation.
    expect(labelKeysFor("roll_dice")).toEqual([baseLabelKey("roll_dice")]);
    expect(labelKeyFor(SAMPLE.roll_dice)).toBe(baseLabelKey("roll_dice"));
  });
});

describe("payload variants", () => {
  it("says which building is being sold", () => {
    expect(labelKeyFor({ kind: "sell_house", player: 0, tile: 3, demolish_hotel: false })).toBe(
      "action.sell_house",
    );
    expect(labelKeyFor({ kind: "sell_house", player: 0, tile: 3, demolish_hotel: true })).toBe(
      "action.sell_house_hotel",
    );
  });

  it("never gives accept and decline the same label", () => {
    const accept = labelKeyFor({ kind: "respond_to_trade", player: 0, accept: true });
    const decline = labelKeyFor({ kind: "respond_to_trade", player: 0, accept: false });
    expect(accept).not.toBe(decline);
    expect(CATALOGUE.get(accept)).not.toBe(CATALOGUE.get(decline));
  });

  it("lists every variant a kind can take, not just the one a sample carries", () => {
    expect(labelKeysFor("respond_to_trade")).toEqual([
      "action.respond_to_trade_accept",
      "action.respond_to_trade_decline",
    ]);
    expect(labelKeysFor("sell_house")).toEqual(["action.sell_house", "action.sell_house_hotel"]);
  });
});

describe("label params", () => {
  it("takes a bid amount from the command", () => {
    expect(labelParamsFor({ kind: "place_bid", player: 0, amount: 240 }, JAIL_FINE)).toEqual({
      amount: 240,
    });
  });

  it("takes bail from the projected ruleset, not from a constant", () => {
    expect(labelParamsFor({ kind: "pay_jail_fine", player: 0 }, 75)).toEqual({ amount: 75 });
  });

  it("gives an unparameterised command nothing", () => {
    expect(labelParamsFor({ kind: "roll_dice", player: 0 }, JAIL_FINE)).toEqual({});
  });
});

describe("tileOf", () => {
  it("finds the square on the four tile-scoped commands", () => {
    expect(tileOf({ kind: "build_house", player: 0, tile: 6 })).toBe(6);
    expect(tileOf({ kind: "sell_house", player: 0, tile: 7, demolish_hotel: false })).toBe(7);
    expect(tileOf({ kind: "mortgage_property", player: 0, tile: 8 })).toBe(8);
    expect(tileOf({ kind: "unmortgage_property", player: 0, tile: 9 })).toBe(9);
  });

  it("is undefined for a command that acts on no square", () => {
    expect(tileOf({ kind: "roll_dice", player: 0 })).toBeUndefined();
    expect(tileOf({ kind: "place_bid", player: 0, amount: 10 })).toBeUndefined();
  });
});

describe("the terminal consequences", () => {
  it("resolves a consequence for every kind that gets a confirm step", () => {
    for (const kind of TERMINAL_COMMANDS) {
      expect(CATALOGUE.has(consequenceKeyFor(kind)), `no consequence for ${kind}`).toBe(true);
    }
  });

  it("writes a consequence only for the kinds that have a confirm step", () => {
    // The old hand-written table needed checking in both directions because it could disagree with
    // the theme. A concatenation cannot — but the *catalogue* still can, by carrying a consequence
    // for a kind that never asks for one. That leaf would be dead text nobody ever reads.
    const orphaned = COMMAND_KINDS.filter(
      (kind) => !requiresConfirmation(kind) && CATALOGUE.has(consequenceKeyFor(kind)),
    );
    expect(orphaned, "consequences for commands that are never confirmed").toEqual([]);
  });

  it("explains a consequence in a sentence rather than restating the label", () => {
    for (const kind of TERMINAL_COMMANDS) {
      const consequence = CATALOGUE.get(consequenceKeyFor(kind)) ?? "";
      // A confirm step whose body is three words teaches nothing. This is a floor, not a style
      // rule: the point of the dialog is that the player understands what they are about to lose.
      expect(consequence.split(" ").length, `${kind}'s consequence is too terse`).toBeGreaterThan(
        6,
      );
      expect(consequence).not.toBe(CATALOGUE.get(baseLabelKey(kind)));
    }
  });
});

/**
 * MON-604: the one consequence that is a lie in Kids Mode.
 *
 * `confirm.consequence.decline_purchase` states that the square goes up for auction, which is the
 * universal rule and is false with `auctions_enabled` off. The dialog that gets it wrong is the one
 * standing in front of a child, so both sentences have to exist and the flag has to pick between
 * them. Note what is *not* under test: whether the command is legal either way. It is, in both.
 */
describe("the consequence of declining depends on whether there are auctions", () => {
  it("keeps the auction sentence under the full rules", () => {
    expect(consequenceKeyFor("decline_purchase", true)).toBe(consequenceKeyFor("decline_purchase"));
    expect(CATALOGUE.get(consequenceKeyFor("decline_purchase", true))).toContain("auction");
  });

  it("says something different, and true, when there are none", () => {
    const key = consequenceKeyFor("decline_purchase", false);
    expect(key).toBe(`confirm.consequence.decline_purchase${NO_AUCTION_SUFFIX}`);
    const sentence = CATALOGUE.get(key);
    expect(sentence, "no sentence for declining in a game with no auctions").toBeDefined();
    // The whole point of the variant: the word that made the other sentence wrong is gone.
    expect(sentence).not.toContain("auction");
    expect(sentence).not.toBe(CATALOGUE.get(consequenceKeyFor("decline_purchase", true)));
  });

  it("leaves every other terminal kind on one sentence", () => {
    // `withdraw_from_auction` needs no variant — it cannot be legal in a game with no auctions in
    // it — and a variant nobody selects is a leaf nobody reads.
    for (const kind of TERMINAL_COMMANDS) {
      if (kind === "decline_purchase") {
        continue;
      }
      expect(consequenceKeyFor(kind, false), `${kind} grew a variant`).toBe(
        consequenceKeyFor(kind, true),
      );
    }
  });
});
