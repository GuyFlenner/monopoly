/**
 * The coverage gate on the kind → label-key bridge.
 *
 * The failure this file exists to prevent is a new engine command landing and the ActionBar
 * printing a raw `build_house` at a six-year-old. Three things have to hold for that to be
 * impossible, and each is tested here rather than reviewed:
 *
 * 1. Every command kind has a key. `Record<CommandKind, …>` is a compile gate, and this is the
 *    runtime one — the compile gate disappears the moment somebody widens the key type.
 * 2. Every key the resolver can emit **exists in the catalogue**. A key that resolves to nothing
 *    is worse than a missing map entry, because `missingKeyHandler` throws and takes the whole bar
 *    down (deliberately, GAP G-F17) — every button, not just the broken one.
 * 3. Every placeholder a label declares is supplied. `action.buy` wants `{{price}}` and nothing on
 *    the wire can give it one; that is the trap this suite is really about, and the reason
 *    `buy_property` maps to a price-free key instead.
 */

import { describe, expect, it } from "vitest";

import type { Command, CommandKind } from "@/api";
import commonEn from "@/i18n/locales/common.en.json";
import { COMMAND_KINDS, TERMINAL_COMMANDS } from "@/theme";

import {
  ACTION_LABEL_KEY,
  CONSEQUENCE_KEY,
  labelKeyFor,
  labelKeysFor,
  labelParamsFor,
  tileOf,
} from "./ActionLabels";

/** The English catalogue as dotted keys, which is how the map spells them. */
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

describe("the kind → label-key map", () => {
  it("has an entry for every command kind the contract declares", () => {
    const missing = COMMAND_KINDS.filter((kind) => {
      const key = ACTION_LABEL_KEY[kind];
      return typeof key !== "string" || key.length === 0;
    });
    expect(missing, "command kinds with no label key").toEqual([]);
  });

  it("names every key under `action.`, so MON-501's rename has one prefix to sweep", () => {
    for (const kind of COMMAND_KINDS) {
      expect(ACTION_LABEL_KEY[kind]).toMatch(/^action\./);
    }
  });

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
    // The one that mattered: `action.buy` wants `{{price}}` and `BuyProperty` carries no tile, so
    // `buy_property` maps to the price-free `action.buy_property`. Pointing this test at
    // `action.buy` would fail, which is the whole reason the price-free key exists.
    expect(unsupplied, "labels with a placeholder nothing fills").toEqual([]);
  });

  it("still needs to exist — the catalogue is not reachable by `action.<kind>` (G-40)", () => {
    // When MON-501 renames the leaves to `action.<command_kind>`, this assertion fails and the
    // failure names the module to delete. That is the intended lifetime of this file.
    const derivable = COMMAND_KINDS.filter((kind) => ACTION_LABEL_KEY[kind] === `action.${kind}`);
    expect(derivable.length).toBeLessThan(COMMAND_KINDS.length);
    expect(ACTION_LABEL_KEY.roll_dice).toBe("action.roll");
  });
});

describe("payload variants", () => {
  it("says which building is being sold", () => {
    expect(labelKeyFor({ kind: "sell_house", player: 0, tile: 3, demolish_hotel: false })).toBe(
      "action.sellHouse",
    );
    expect(labelKeyFor({ kind: "sell_house", player: 0, tile: 3, demolish_hotel: true })).toBe(
      "action.sellHouse_hotel",
    );
  });

  it("never gives accept and decline the same label", () => {
    const accept = labelKeyFor({ kind: "respond_to_trade", player: 0, accept: true });
    const decline = labelKeyFor({ kind: "respond_to_trade", player: 0, accept: false });
    expect(accept).not.toBe(decline);
    expect(CATALOGUE.get(accept)).not.toBe(CATALOGUE.get(decline));
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
  it("covers exactly the theme's terminal set, in both directions", () => {
    const explained = new Set(Object.keys(CONSEQUENCE_KEY));
    expect([...explained].sort()).toEqual([...TERMINAL_COMMANDS].sort());
  });

  it("resolves every consequence against the catalogue", () => {
    for (const kind of TERMINAL_COMMANDS) {
      const key = CONSEQUENCE_KEY[kind];
      expect(key, `no consequence for ${kind}`).toBeDefined();
      expect(CATALOGUE.has(key ?? "")).toBe(true);
    }
  });

  it("explains a consequence in a sentence rather than restating the label", () => {
    for (const kind of TERMINAL_COMMANDS) {
      const consequence = CATALOGUE.get(CONSEQUENCE_KEY[kind] ?? "") ?? "";
      // A confirm step whose body is three words teaches nothing. This is a floor, not a style
      // rule: the point of the dialog is that the player understands what they are about to lose.
      expect(consequence.split(" ").length, `${kind}'s consequence is too terse`).toBeGreaterThan(
        6,
      );
      expect(consequence).not.toBe(CATALOGUE.get(ACTION_LABEL_KEY[kind]));
    }
  });
});
