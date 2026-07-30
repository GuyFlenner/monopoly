import { describe, expect, it } from "vitest";

import type { Command, CommandKind, CommandOfKind } from "@/api";
import commonEn from "@/i18n/locales/common.en.json";
import commonHe from "@/i18n/locales/common.he.json";
import { COMMAND_KINDS, TERMINAL_COMMANDS } from "@/theme";

import { HINT_ORDER, preferenceOf, rankCommands, reasonKeyFor, suggest } from "./hints";

/**
 * What must be true of the ranking, and what would be a silent disaster.
 *
 * The disasters are three, and each has a test that fails *only* if it happens:
 *
 * 1. **A hint that invents a move.** Nothing here may return a command that was not handed in. The
 *    identity assertions below are what make that checkable rather than merely intended: the
 *    returned object has to be the very object from the input array, so a "helpful" reconstruction
 *    (`{ kind, player }`) fails even when it is structurally identical.
 * 2. **A hint that cheerfully points at bankruptcy.** The terminal invariant is asserted over the
 *    whole cross product of kinds rather than by spot-checking the three that are terminal today,
 *    because the classification lives in `theme/actions.ts` and can change there.
 * 3. **A hint that reorders the bar.** `rankCommands` must leave its input alone; the action bar
 *    renders that same array verbatim, and an in-place sort here would silently rewrite it.
 *
 * A note on what is deliberately *not* asserted: no test here says "buying is better than ending
 * the turn" as a matter of play. The order is a statement about which decision is in front of the
 * player, and pinning individual pairs as strategy would make the file unchangeable for the wrong
 * reason. The pairs that *are* pinned are the ones with a stated principle behind them.
 */

const player = 0;

function roll(): Command {
  return { kind: "roll_dice", player };
}
function endTurn(): Command {
  return { kind: "end_turn", player, elapsed_seconds: null };
}
function buy(): Command {
  return { kind: "buy_property", player };
}
function build(tile: number): Command {
  return { kind: "build_house", player, tile };
}
function bankrupt(): Command {
  return { kind: "declare_bankruptcy", player };
}
function decline(): Command {
  return { kind: "decline_purchase", player };
}
function bid(amount: number): Command {
  return { kind: "place_bid", player, amount };
}
function withdraw(): Command {
  return { kind: "withdraw_from_auction", player };
}
function sellHouse(tile: number): Command {
  return { kind: "sell_house", player, tile, demolish_hotel: false };
}
function mortgage(tile: number): Command {
  return { kind: "mortgage_property", player, tile };
}
function answerTrade(accept: boolean): CommandOfKind<"respond_to_trade"> {
  return { kind: "respond_to_trade", player, accept };
}
function jailCard(): Command {
  return { kind: "use_jail_card", player };
}
function payBail(): Command {
  return { kind: "pay_jail_fine", player };
}
function rollForJail(): Command {
  return { kind: "roll_for_jail", player };
}

describe("HINT_ORDER covers the engine's whole vocabulary", () => {
  it("ranks every command kind exactly once", () => {
    // The compile-time gate (`NoUnrankedCommandKind`) catches a *missing* kind. This catches the
    // other two ways the list can be wrong — a duplicate, which makes `indexOf` silently prefer the
    // first, and a length that has drifted from the contract.
    expect([...HINT_ORDER].sort()).toEqual([...COMMAND_KINDS].sort());
    expect(new Set(HINT_ORDER).size).toBe(HINT_ORDER.length);
  });

  it("puts every terminal kind behind every kind that is not one", () => {
    const terminal = COMMAND_KINDS.filter((kind) => TERMINAL_COMMANDS.has(kind));
    const ordinary = COMMAND_KINDS.filter((kind) => !TERMINAL_COMMANDS.has(kind));
    expect(terminal.length, "no terminal kinds — the theme has changed").toBeGreaterThan(0);

    const worstOrdinary = Math.max(...ordinary.map(preferenceOf));
    for (const kind of terminal) {
      expect(preferenceOf(kind), `${kind} outranks an ordinary move`).toBeGreaterThan(
        worstOrdinary,
      );
    }
  });

  it("opens with the roll and ends with giving up", () => {
    // The two ends of the list are the two claims the module docstring makes about it: a turn cannot
    // start without the roll, and leaving the game is what is left when nothing else is.
    expect(HINT_ORDER[0]).toBe<CommandKind>("roll_dice");
    expect(HINT_ORDER.at(-1)).toBe<CommandKind>("declare_bankruptcy");
  });
});

describe("rankCommands", () => {
  it("has nothing to rank in an empty list", () => {
    expect(rankCommands([])).toEqual([]);
  });

  it("returns the single command it was given, and that very object", () => {
    const only = buy();
    const ranked = rankCommands([only]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toBe(only);
  });

  it("promotes the roll over an ordinary move offered before it", () => {
    const [first] = rankCommands([endTurn(), roll()]);
    expect(first?.kind).toBe<CommandKind>("roll_dice");
  });

  it("demotes a terminal move behind every ordinary one", () => {
    const ranked = rankCommands([bankrupt(), decline(), sellHouse(1), buy()]);
    expect(ranked.map((command) => command.kind)).toEqual<CommandKind[]>([
      "buy_property",
      "sell_house",
      "decline_purchase",
      "declare_bankruptcy",
    ]);
  });

  it("keeps the engine's order between two commands of one kind", () => {
    // Which of four streets to build on is not this module's judgement; the projection's order is
    // the answer, and it must survive the sort.
    const houses = [build(39), build(1), build(6)];
    expect(rankCommands(houses)).toEqual(houses);
  });

  it("keeps whichever answer to a trade the engine listed first", () => {
    // Choosing *between* the two answers would be strategy, and a hint that always promoted `accept`
    // would be advising a child to take every offer. Asserted in both directions, because a sort
    // that happens to be stable for one input order is not a tie-break rule.
    const accept = answerTrade(true);
    const refuse = answerTrade(false);
    expect(rankCommands([accept, refuse])).toEqual([accept, refuse]);
    expect(rankCommands([refuse, accept])).toEqual([refuse, accept]);
  });

  it("leaves the array it was given untouched", () => {
    // `legal_commands` is what the action bar renders verbatim. An in-place sort here would reorder
    // the bar, which is the one thing ADR-005 forbids on this side of the wire.
    const given: readonly Command[] = [bankrupt(), roll()];
    const snapshot = [...given];
    rankCommands(given);
    expect(given).toEqual(snapshot);
  });

  it("returns every command it was given, dropping none", () => {
    const given = [bankrupt(), roll(), build(1), build(3), endTurn()];
    expect(rankCommands(given)).toHaveLength(given.length);
    expect(new Set(rankCommands(given))).toEqual(new Set(given));
  });
});

describe("suggest", () => {
  it("suggests nothing when the engine offered nothing", () => {
    // A bot's turn, a finished game, an interrupt belonging to another seat. There is no fallback
    // suggestion, because a suggestion with nothing behind it would be an invented move.
    expect(suggest([])).toBeNull();
  });

  it("hands back the very command object it was given", () => {
    const only = roll();
    expect(suggest([only])?.command).toBe(only);
  });

  it("names the reason key for the kind it chose", () => {
    expect(suggest([endTurn(), roll()])?.reasonKey).toBe("hint.reason.roll_dice");
  });

  it("flags a terminal suggestion as terminal", () => {
    // The only way `HintPanel` can know not to offer a shortcut past the confirm dialog.
    expect(suggest([bankrupt()])).toMatchObject({ terminal: true });
    expect(suggest([roll()])).toMatchObject({ terminal: false });
  });
});

describe("the interrupt phases, where the legal set is not a whole turn", () => {
  it("points at the bid rather than the withdrawal during an auction", () => {
    // Withdrawing is terminal for the lot; bidding is the decision the auction is asking for.
    expect(suggest([withdraw(), bid(60)])?.command.kind).toBe<CommandKind>("place_bid");
  });

  it("points at the trade offer waiting for an answer", () => {
    const hint = suggest([answerTrade(true), answerTrade(false), bankrupt()]);
    expect(hint?.command.kind).toBe<CommandKind>("respond_to_trade");
    expect(hint?.reasonKey).toBe("hint.reason.respond_to_trade");
  });

  it("points at raising cash before giving up, during debt settlement", () => {
    // The frame where the difference matters most: a player who can still sell a house has not lost.
    const hint = suggest([bankrupt(), mortgage(3), sellHouse(1)]);
    expect(hint?.command.kind).toBe<CommandKind>("sell_house");
  });

  it("points at the free way out of jail before the paid one", () => {
    expect(suggest([payBail(), rollForJail(), jailCard()])?.command.kind).toBe<CommandKind>(
      "use_jail_card",
    );
    expect(suggest([payBail(), rollForJail()])?.command.kind).toBe<CommandKind>("roll_for_jail");
  });

  it("suggests bankruptcy when the engine offers nothing else", () => {
    // Not a cheerful suggestion — the honest one. The reason key is what has to carry that.
    expect(suggest([bankrupt()])?.reasonKey).toBe("hint.reason.declare_bankruptcy");
  });
});

describe("every reason resolves, in both languages", () => {
  function leaf(catalogue: unknown, key: string): unknown {
    return key
      .split(".")
      .reduce<unknown>(
        (node, part) =>
          typeof node === "object" && node !== null
            ? (node as Record<string, unknown>)[part]
            : undefined,
        catalogue,
      );
  }

  it.each([
    ["en", commonEn],
    ["he", commonHe],
  ])("has a %s sentence for every command kind a hint can land on", (_language, catalogue) => {
    // Walked from the *engine's* kind list, not from the catalogue — so a new command reaches this
    // test before it reaches a player as a blank line under "What now?".
    const missing = COMMAND_KINDS.filter(
      (kind) => typeof leaf(catalogue, reasonKeyFor(kind)) !== "string",
    );
    expect(missing).toEqual([]);
  });
});
