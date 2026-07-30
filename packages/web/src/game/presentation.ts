/**
 * What the ruleset in force means for the *screen* — and nothing about what is legal.
 *
 * Kids Mode is not a second UI. It is the same components reading four presentation switches off
 * the ruleset the server already ships on `state.ruleset` (MON-604). Reading a flag in order to
 * decide whether to *draw* a panel is presentation; deciding whether a command may be *sent* is
 * the engine's, and no field below is ever consulted for that.
 *
 * The distinction is worth being pedantic about, because the two look identical in a diff:
 *
 * - `auctions: false` means "render no affordance that talks about an auction". It does **not**
 *   mean "refuse an auction". If the engine ever pushed an auction interrupt into a game with
 *   auctions switched off, `GameScreen` still mounts the panel — hiding a live phase would strand
 *   the table with commands nobody could reach, which is a worse failure than an odd panel.
 * - `mortgages: false` means the same for mortgage wording. The mortgage *readouts* in the dossier
 *   and on a tile are not gated at all: they render from `properties[i].mortgaged`, so with
 *   mortgages off they are simply never true. A gate there would be a second opinion about data.
 *
 * ## Why `kids` reads the rule set's *name*
 *
 * The comfort scale and the simpler wording are not consequences of any single flag — a game with
 * auctions off is not automatically a game a six-year-old is playing. `ruleset.py` names `name` as
 * its one identity field for exactly this reason, so identity is what this asks for. `KIDS` is
 * typed against the generated contract, so renaming the variant server-side is a compile error
 * here rather than a silently universal-looking kids game.
 */

import type { Ruleset } from "@/api";

/** The variant whose comfort scale and wording step up. Typed, so a rename cannot pass silently. */
export const KIDS: Ruleset["name"] = "kids";

export interface Presentation {
  /**
   * Kids Mode: bigger targets (`data-comfort`), simpler wording, a prominent turn banner.
   *
   * Identity, not a capability — see the module docstring.
   */
  readonly kids: boolean;
  /** Draw affordances and sentences that talk about auctions. `ruleset.auctions_enabled`. */
  readonly auctions: boolean;
  /** Draw affordances and sentences that talk about mortgages. `ruleset.mortgages_enabled`. */
  readonly mortgages: boolean;
  /** Hints are open on the page rather than folded away. `ruleset.hints_enabled` (MON-605). */
  readonly hintsProminent: boolean;
}

/**
 * What the screen looks like under the universal rules, and the fallback before a view arrives.
 *
 * Every switch is on except the hint prominence: under the full rules hints exist but stay quiet,
 * which is MON-605's "available but quieter in normal games".
 */
export const FULL_RULES_PRESENTATION: Presentation = {
  kids: false,
  auctions: true,
  mortgages: true,
  hintsProminent: false,
};

/**
 * Read the four switches off a ruleset.
 *
 * `undefined` — no view yet — answers with the universal presentation rather than with a
 * half-drawn screen: the first frame of a kids game then steps up when it arrives, which is a
 * layout change nobody is mid-gesture through.
 */
export function presentationFor(ruleset: Ruleset | undefined): Presentation {
  if (ruleset === undefined) {
    return FULL_RULES_PRESENTATION;
  }
  return {
    kids: ruleset.name === KIDS,
    auctions: ruleset.auctions_enabled,
    mortgages: ruleset.mortgages_enabled,
    hintsProminent: ruleset.hints_enabled,
  };
}
