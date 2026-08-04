import { readFileSync } from "node:fs";
import { URL as NodeURL, fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ACTION_THEME,
  ACTION_TONE,
  COMMAND_KINDS,
  PORTFOLIO_COMMANDS,
  TERMINAL_COMMANDS,
  ZONE_ORDER,
  requiresConfirmation,
  zoneOf,
  type CommandKind,
} from "./actions";
import { ICON_PATH } from "./icons";

/**
 * Coverage, three ways.
 *
 * `ACTION_THEME` is typed `Record<CommandKind, …>`, so a missing kind is already a compile error
 * — the same trick `groups.ts` uses. That gate is the strongest one available, and it is also the
 * one that evaporates the moment somebody widens a key type to make an error go away. So the
 * runtime tests below re-check the same property from the other end, and the last one goes
 * further: it reads `src/api/generated.ts` and recovers the command kinds from the *document*, so
 * a regenerated contract that adds a command fails here even without a type-check.
 */

/**
 * Recover the command kinds from the generated OpenAPI types.
 *
 * `CommandRequest.command` is a union of schema references; each referenced schema declares a
 * literal `kind`. Walking that is more work than hardcoding seventeen strings, and that is
 * precisely why it is worth doing — a hardcoded list agrees with a stale contract forever.
 */
function commandKindsFromContract(): readonly string[] {
  const source = readFileSync(
    fileURLToPath(new NodeURL("../api/generated.ts", import.meta.url)),
    "utf8",
  );

  const union = /CommandRequest:\s*\{[^}]*?command:\s*([^;]+);/.exec(source);
  expect(union, "could not find CommandRequest.command in the generated contract").not.toBeNull();

  const schemaNames = [...(union?.[1] ?? "").matchAll(/schemas"\]\["(\w+)"\]/g)].map(
    (match) => match[1],
  );
  expect(schemaNames.length, "CommandRequest.command referenced no schemas").toBeGreaterThan(0);

  return schemaNames.map((name) => {
    const start = source.indexOf(`\n        ${name ?? ""}: {`);
    expect(start, `schema ${name ?? "?"} not found in the generated contract`).toBeGreaterThan(-1);
    const kind = /kind:\s*"([a-z_]+)"/.exec(source.slice(start));
    expect(kind, `schema ${name ?? "?"} declares no literal kind`).not.toBeNull();
    return kind?.[1] ?? "";
  });
}

describe("ACTION_THEME coverage", () => {
  it("themes every command kind the contract can send (G-A1)", () => {
    for (const kind of COMMAND_KINDS) {
      expect(ACTION_THEME[kind], `${kind} has no theme`).toBeDefined();
    }
    expect(Object.keys(ACTION_THEME).sort()).toEqual([...COMMAND_KINDS].sort());
  });

  it("themes nothing the contract cannot send", () => {
    const contractKinds = commandKindsFromContract();
    expect([...COMMAND_KINDS].sort()).toEqual([...contractKinds].sort());
    expect(contractKinds).toHaveLength(17);
  });

  it("draws a glyph that exists for every kind, and a badge that exists where one is claimed", () => {
    for (const kind of COMMAND_KINDS) {
      const theme = ACTION_THEME[kind];
      expect(ICON_PATH[theme.icon], `${kind}: glyph ${theme.icon} is missing`).toBeTruthy();
      if (theme.modifier !== undefined) {
        expect(
          ICON_PATH[theme.modifier],
          `${kind}: badge ${theme.modifier} is missing`,
        ).toBeTruthy();
      }
    }
  });

  it("gives no two kinds the same glyph-and-badge pair", () => {
    // Two buttons drawn identically are one button as far as a pre-reader is concerned.
    const marks = COMMAND_KINDS.map((kind) => {
      const theme = ACTION_THEME[kind];
      return `${theme.icon}+${theme.modifier ?? ""}`;
    });
    const duplicates = marks.filter((mark, index) => marks.indexOf(mark) !== index);
    expect(duplicates, "two command kinds render the same icon").toEqual([]);
  });

  it("keys everything in the engine's snake_case (ADR-003 §6)", () => {
    for (const kind of COMMAND_KINDS) {
      expect(kind, `${kind} is not snake_case`).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
    }
  });
});

describe("consequence classes", () => {
  it("marks exactly the three terminal commands MON-405 must confirm", () => {
    expect([...TERMINAL_COMMANDS].sort()).toEqual(
      ["declare_bankruptcy", "decline_purchase", "withdraw_from_auction"].sort(),
    );
  });

  it("requires confirmation for exactly the terminal commands, in a game with auctions", () => {
    for (const kind of COMMAND_KINDS) {
      expect(requiresConfirmation(kind, true), kind).toBe(ACTION_THEME[kind].class === "terminal");
    }
    expect(COMMAND_KINDS.filter((kind) => requiresConfirmation(kind, true))).toHaveLength(3);
  });

  it("drops the confirm for a declined purchase when there is no auction to lose it to", () => {
    /*
      MON-718, and the one place the table and the predicate deliberately differ.

      `decline_purchase` stays `terminal` in `ACTION_THEME` because that is its cost *when a deed goes
      under the hammer*. With auctions off — this product's default (MON-712) — declining is not
      irreversible at all: the square stays unowned and the next player to stop there may buy it. A
      dialog then interrupts the commonest action in the game to warn about something that will not
      happen, which is the owner's report of it.

      Nothing else moves: the other two are final under every rule set that can produce them.
    */
    expect(requiresConfirmation("decline_purchase", false)).toBe(false);
    expect(requiresConfirmation("decline_purchase", true)).toBe(true);
    for (const kind of ["declare_bankruptcy", "withdraw_from_auction"] as const) {
      expect(requiresConfirmation(kind, false), kind).toBe(true);
      expect(requiresConfirmation(kind, true), kind).toBe(true);
    }
    // And no non-terminal command starts confirming because a table turned auctions on.
    const confirming = COMMAND_KINDS.filter((kind) => requiresConfirmation(kind, false));
    expect(confirming.sort()).toEqual(["declare_bankruptcy", "withdraw_from_auction"]);
  });

  it("does not let tone stand in for the class", () => {
    // `decline_purchase` is only `caution` in colour and still needs the confirm step: a shade
    // of red is exactly what a protan player cannot see, so the class carries the weight.
    expect(ACTION_THEME.decline_purchase.tone).toBe("caution");
    expect(requiresConfirmation("decline_purchase", true)).toBe(true);
    expect(ACTION_THEME.declare_bankruptcy.tone).toBe("danger");
    // …and a danger tone is not sufficient on its own either: something can look severe and be
    // ordinary. Assert the mapping is not just "danger ⇒ terminal".
    const dangerKinds = COMMAND_KINDS.filter((kind) => ACTION_THEME[kind].tone === "danger");
    expect(dangerKinds.length).toBeLessThan(TERMINAL_COMMANDS.size);
  });

  it("uses one of exactly three classes for every kind", () => {
    for (const kind of COMMAND_KINDS) {
      expect(["reversible", "consequential", "terminal"]).toContain(ACTION_THEME[kind].class);
    }
  });
});

describe("zones", () => {
  it("files every command kind under exactly one of the two zones", () => {
    // The coverage that matters for MON-UX1: a kind with no zone is a chit the bar renders nowhere.
    // `Record<CommandKind, …>` already makes that a compile error; this is the runtime restatement,
    // for the day somebody widens the key type.
    for (const kind of COMMAND_KINDS) {
      expect(ZONE_ORDER, `${kind} has no zone`).toContain(zoneOf(kind));
    }
    expect(new Set(COMMAND_KINDS.map(zoneOf)).size, "one zone is unused").toBe(ZONE_ORDER.length);
  });

  it("puts the estate kinds in `portfolio` and the turn's own moves in `flow`", () => {
    // Named rather than derived, because this *is* the decision — a test that recomputed it from
    // `ACTION_THEME` would agree with any mistake. The five are the kinds `_portfolio_gate` opens to
    // every solvent player in a quiet phase; see the module docstring on why that coincidence is the
    // vocabulary agreeing with itself and not a rule being copied.
    expect([...PORTFOLIO_COMMANDS].sort()).toEqual([
      "build_house",
      "mortgage_property",
      "propose_trade",
      "sell_house",
      "unmortgage_property",
    ]);
  });

  it("keeps `declare_bankruptcy` in the flow zone, terminal though it is", () => {
    // The one entry a reader is most likely to "fix". In DEBT_SETTLEMENT it is one of the two answers
    // the game is waiting for, and folding the way out of a phase behind "your properties" is the bug
    // this whole change exists not to introduce. It is also where `HINT_ORDER` and `zone` deliberately
    // disagree, which is the argument for them being two tables.
    expect(zoneOf("declare_bankruptcy")).toBe("flow");
    expect(requiresConfirmation("declare_bankruptcy", false)).toBe(true);
  });

  it("answers the trade frame's two sides with `flow`, not `portfolio`", () => {
    // Answering an offer is the table waiting on this seat; *drafting* one is estate management.
    expect(zoneOf("respond_to_trade")).toBe("flow");
    expect(zoneOf("cancel_trade")).toBe("flow");
    expect(zoneOf("propose_trade")).toBe("portfolio");
  });

  it("lays flow out before portfolio", () => {
    // The one place the order is written down. A bar that put the estate first would be the original
    // complaint with extra headings.
    expect([...ZONE_ORDER]).toEqual(["flow", "portfolio"]);
  });
});

describe("action tones", () => {
  it("defines all four tones in both themes, as #rrggbb", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const tone of ["primary", "neutral", "caution", "danger"] as const) {
        const colors = ACTION_TONE[theme][tone];
        for (const [slot, value] of Object.entries(colors)) {
          expect(value, `${theme}.${tone}.${slot}`).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });

  it("uses a tone that exists for every command kind", () => {
    for (const kind of COMMAND_KINDS) {
      const kindTyped: CommandKind = kind;
      expect(ACTION_TONE.light[ACTION_THEME[kindTyped].tone]).toBeDefined();
      expect(ACTION_TONE.dark[ACTION_THEME[kindTyped].tone]).toBeDefined();
    }
  });
});
