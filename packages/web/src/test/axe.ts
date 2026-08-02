/**
 * `axe-core` against a rendered fragment.
 *
 * The E4 gate says "axe clean", and until MON-708 that was checked by reading — the `<div tabIndex>`
 * in `EventLog.tsx` cites `scrollable-region-focusable` by name in a comment, which is a developer
 * having run axe once, by hand, and written down what it said. This runs it.
 *
 * ## What it can and cannot see
 *
 * axe in jsdom checks **structure**: roles, names, labels, relationships, ARIA validity, duplicate
 * ids, list and table shape. It cannot check **colour**, because jsdom computes no colours — so
 * `color-contrast` is disabled below rather than left to pass vacuously. Contrast is asserted
 * numerically instead, against the palette, in `theme/contrast.test.ts`, which is the honest place
 * for it: a ratio is arithmetic on two hex values and needs no browser.
 *
 * `region` is disabled for the same class of reason. It requires every piece of content to sit
 * inside a landmark, which is true of the mounted app and false of a fragment rendered on its own —
 * a component test would be reporting the absence of the shell it deliberately did not mount.
 */

import axe, { type AxeResults, type Result } from "axe-core";
import { expect } from "vitest";

/**
 * Rules that cannot be answered in jsdom, and where each is answered instead.
 *
 * Kept short and each entry justified. A growing list here is a gate being turned off one rule at a
 * time, which is worse than no gate because it looks like one.
 */
export const RULES_JSDOM_CANNOT_ANSWER = {
  // jsdom computes no colours; asserted numerically in `theme/contrast.test.ts`.
  "color-contrast": { enabled: false },
  // A fragment has no landmarks by design; asserted on the mounted app in `App.test.tsx`.
  region: { enabled: false },
} as const;

/** One violation, as a line a developer can act on: the rule, the impact, and what to change. */
function describe(violation: Result): string {
  const where = violation.nodes.map((node) => node.target.join(" ")).join(", ");
  return `${violation.id} (${violation.impact ?? "unknown"}): ${violation.help} — at ${where}`;
}

/**
 * Assert that `container` has no axe violations.
 *
 * Takes an element rather than running against `document`, so a test asserts on what it rendered
 * rather than on whatever else the suite has left in the body.
 */
export async function expectAxeClean(container: Element): Promise<void> {
  const results: AxeResults = await axe.run(container, {
    rules: { ...RULES_JSDOM_CANNOT_ANSWER },
    // `resultTypes` keeps axe from assembling the passes and incompletes it is not asked about,
    // which is most of the runtime on a small fragment.
    resultTypes: ["violations"],
  });
  expect(results.violations.map(describe)).toEqual([]);
}

/**
 * Assert that a **whole screen** has no axe violations, with `region` switched back on (MON-703).
 *
 * The difference from {@link expectAxeClean} is one rule, and it is the reason this function exists
 * rather than a flag on that one. `region` — "all page content is contained by landmarks" — is the
 * only rule in the set whose answer depends on the shell, so it is the only rule a component test
 * *has* to switch off and the only rule a screen sweep genuinely adds. Turning it off everywhere
 * would leave the product with no assertion at all that its content sits inside `<main>`, `<header>`
 * and `<aside>`; turning it on in a component test would report the absence of a shell the test
 * deliberately did not mount.
 *
 * `color-contrast` stays off for the reason in this module's docstring: jsdom computes no colours,
 * and the honest home for a ratio is the arithmetic in `theme/contrast.test.ts`.
 *
 * Pass `document.body`, not a render container: the Announcer's two live regions and any portalled
 * dialog are siblings of the container, and a landmark audit that cannot see them is measuring a
 * different page from the one a player gets.
 */
export async function expectAxeCleanScreen(container: Element): Promise<void> {
  const results: AxeResults = await axe.run(container, {
    rules: {
      // jsdom computes no colours; asserted numerically in `theme/contrast.test.ts`.
      "color-contrast": { enabled: false },
    },
    resultTypes: ["violations"],
  });
  expect(results.violations.map(describe)).toEqual([]);
}
