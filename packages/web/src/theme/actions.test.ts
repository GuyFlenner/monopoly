import { readFileSync } from "node:fs";
import { URL as NodeURL, fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ACTION_THEME,
  ACTION_TONE,
  COMMAND_KINDS,
  TERMINAL_COMMANDS,
  requiresConfirmation,
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

  it("requires confirmation for exactly the terminal commands, and only those", () => {
    for (const kind of COMMAND_KINDS) {
      expect(requiresConfirmation(kind), kind).toBe(ACTION_THEME[kind].class === "terminal");
    }
    expect(COMMAND_KINDS.filter(requiresConfirmation)).toHaveLength(3);
  });

  it("does not let tone stand in for the class", () => {
    // `decline_purchase` is only `caution` in colour and still needs the confirm step: a shade
    // of red is exactly what a protan player cannot see, so the class carries the weight.
    expect(ACTION_THEME.decline_purchase.tone).toBe("caution");
    expect(requiresConfirmation("decline_purchase")).toBe(true);
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
