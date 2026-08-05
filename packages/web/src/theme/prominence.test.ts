/**
 * What must be true of the phase-emphasis table.
 *
 * The table's whole safety argument is that a wrong entry can only leave a labelled, one-keystroke
 * disclosure folded — so the tests worth writing are about **coverage** (a phase with no answer would
 * be a `undefined` reaching `useState`) and about the two entries that carry the design
 * (`debt_settlement` and `auction`). The reachability consequence is asserted where it can actually be
 * observed, in `panels/ActionBar.test.tsx`.
 *
 * The phase list is recovered from the generated contract rather than typed out, the same trick
 * `actions.test.ts` uses for the command kinds: a hardcoded list agrees with a stale contract forever,
 * and the failure this guards against is precisely a *new* phase landing unclassified.
 */

import { readFileSync } from "node:fs";
import { URL as NodeURL, fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Phase } from "../api/types";
import { PORTFOLIO_COMMANDS, ZONE_ORDER } from "./actions";
import {
  GROWTH_COMMANDS,
  PHASE_EMPHASIS,
  RAISING_EMPHASIS_PHASES,
  emphasisFor,
} from "./prominence";

/** Every member of the `Phase` enum, read out of the OpenAPI types. */
function phasesFromContract(): readonly string[] {
  const source = readFileSync(
    fileURLToPath(new NodeURL("../api/generated.ts", import.meta.url)),
    "utf8",
  );
  const declaration = /\n {8}Phase:\s*([^;]+);/.exec(source);
  expect(declaration, "could not find the Phase schema in the generated contract").not.toBeNull();
  const members = [...(declaration?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  expect(members.length, "Phase declared no members").toBeGreaterThan(0);
  return members.filter((member): member is string => member !== undefined);
}

describe("PHASE_EMPHASIS coverage", () => {
  it("answers every phase the contract can send", () => {
    for (const phase of phasesFromContract()) {
      expect(PHASE_EMPHASIS[phase as Phase], `${phase} has no emphasis`).toBeDefined();
    }
  });

  it("classifies nothing the contract does not have", () => {
    expect([...Object.keys(PHASE_EMPHASIS)].sort()).toEqual([...phasesFromContract()].sort());
  });

  it("answers with a zone the bar knows how to lay out", () => {
    for (const zone of Object.values(PHASE_EMPHASIS)) {
      expect(ZONE_ORDER).toContain(zone);
    }
  });
});

describe("which phases put the estate front and centre", () => {
  it("emphasises exactly the two raising phases", () => {
    // Named, not derived: this is the decision. `debt_settlement` is what the brief required —
    // mortgaging and selling are the alternative to leaving the game, and a static demotion that
    // ignored the phase would have been a new bug. `auction` is included because the engine's own
    // reason for opening sale and mortgage there is the bidder who needs to fund a bid.
    expect([...RAISING_EMPHASIS_PHASES].sort()).toEqual(["auction", "debt_settlement"]);
  });

  it("leaves the ordinary turn quiet", () => {
    for (const phase of ["awaiting_roll", "awaiting_end_turn", "jail_decision"] as const) {
      expect(emphasisFor(phase)).toBe("flow");
    }
  });

  it("answers `flow` for no phase at all", () => {
    // The first frame, before a view arrives. The quieter presentation, and safe by the argument in
    // the module docstring: a folded zone is still a reachable one.
    expect(emphasisFor(undefined)).toBe("flow");
  });
});

describe("a growth move makes the estate the point whatever the phase says (MON-724)", () => {
  it("holds the boundary at building alone", () => {
    // Named, not derived: this is the decision, and its cost is that the estate zone opens on the turn
    // a group is completed. `mortgage_property` here would open it on nearly every turn instead, which
    // is the clutter MON-711 removed.
    expect([...GROWTH_COMMANDS]).toEqual(["build_house"]);
  });

  it("opens the estate in the phases the table calls quiet", () => {
    for (const phase of ["awaiting_roll", "awaiting_end_turn", "jail_decision"] as const) {
      expect(emphasisFor(phase, ["roll_dice", "build_house"])).toBe("portfolio");
    }
  });

  it("leaves a turn without a build alone", () => {
    // The regression guard on the entry above: every *other* portfolio kind at once must still not
    // open the zone, or the exception has quietly become the rule.
    const noGrowth = [...PORTFOLIO_COMMANDS].filter((kind) => !GROWTH_COMMANDS.has(kind));
    expect(
      noGrowth.length,
      "the portfolio zone should hold more than the growth move",
    ).toBeGreaterThan(0);
    expect(emphasisFor("awaiting_roll", noGrowth)).toBe("flow");
  });

  it("changes nothing about a phase that already emphasised the estate", () => {
    // `legality.py` offers no build while raising, so this is the belt-and-braces case rather than a
    // reachable one — but a growth kind must not be able to *close* anything.
    for (const phase of [...RAISING_EMPHASIS_PHASES]) {
      expect(emphasisFor(phase, ["sell_house"])).toBe("portfolio");
      expect(emphasisFor(phase, ["build_house"])).toBe("portfolio");
    }
  });

  it("treats an empty legal set as the phase's answer alone", () => {
    expect(emphasisFor("awaiting_roll", [])).toBe("flow");
    expect(emphasisFor("debt_settlement", [])).toBe("portfolio");
  });
});
