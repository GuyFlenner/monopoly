/**
 * Bidi isolation (GAP G-43).
 *
 * The defect this prevents is a *rendering* defect: the DOM string is correct and the screen is
 * wrong, so no assertion on `textContent` can catch it. What can be asserted is the mechanism —
 * that an isolate is present exactly where the bidirectional algorithm needs one, and absent where
 * it would be two invisible characters doing nothing.
 *
 * So these tests are about placement, and the `describe` below on real catalogue sentences is the
 * one that would have caught the shipped bug: three numbers and a hyphen in one Hebrew sentence.
 */

import { describe, expect, it } from "vitest";

import { i18n, initI18n, applyLocale } from ".";
import { isolate, isolateForDirection, needsIsolation, stripIsolates } from "./bidi";

const FSI = "⁨";
const PDI = "⁩";

describe("needsIsolation", () => {
  it("isolates a Latin run inside RTL text", () => {
    expect(needsIsolation("Ruti", "rtl")).toBe(true);
  });

  it("isolates digits inside RTL text", () => {
    // The case that actually breaks. Digits are *weak* to the algorithm — they take direction from
    // their neighbours — which is why two of them with a comma between reorder.
    expect(needsIsolation("200", "rtl")).toBe(true);
    expect(needsIsolation("1500", "rtl")).toBe(true);
  });

  it("isolates a Hebrew run inside LTR text", () => {
    // Isolation is not an RTL feature. A Hebrew player name in an English sentence is the same
    // defect mirrored, and a formatter that only handled one direction would ship half a fix.
    expect(needsIsolation("רותי", "ltr")).toBe(true);
  });

  it("leaves text that already runs the page's way alone", () => {
    expect(needsIsolation("רותי", "rtl")).toBe(false);
    expect(needsIsolation("Ruti", "ltr")).toBe(false);
  });

  it("leaves text with no direction at all alone", () => {
    // An isolate around an em dash is two invisible characters with no job, and they would land in
    // every assertion in the suite.
    for (const neutral of ["", "—", "…", " ", "(", "·"]) {
      expect(needsIsolation(neutral, "rtl"), JSON.stringify(neutral)).toBe(false);
      expect(needsIsolation(neutral, "ltr"), JSON.stringify(neutral)).toBe(false);
    }
  });
});

describe("isolateForDirection", () => {
  it("wraps in FSI and PDI, in that order", () => {
    expect(isolateForDirection("200", "rtl")).toBe(`${FSI}200${PDI}`);
  });

  it("does not wrap twice", () => {
    // A value that came through a nested `$t()` has already been formatted once.
    const once = isolate("200");
    expect(isolateForDirection(once, "rtl")).toBe(once);
  });

  it("round-trips through stripIsolates", () => {
    expect(stripIsolates(isolateForDirection("Ruti", "rtl"))).toBe("Ruti");
  });
});

describe("the formatter, through i18next", () => {
  it("isolates every interpolated value in a Hebrew sentence", async () => {
    await initI18n("he");
    applyLocale("he");

    // `a11y.dice_result` is the sentence the isolation exists for: "יצא {{first}} ו-{{second}}, סך
    // הכול {{total}}." — three weak digit runs, separated by a hyphen and a comma, inside RTL text.
    const rendered = i18n.t("a11y.dice_result", { first: 3, second: 5, total: 8 });

    expect(rendered).toContain(`${FSI}3${PDI}`);
    expect(rendered).toContain(`${FSI}5${PDI}`);
    expect(rendered).toContain(`${FSI}8${PDI}`);
    // The sentence itself is untouched — isolation wraps the values, never the catalogue text.
    expect(stripIsolates(rendered)).toBe("יצא 3 ו-5, סך הכול 8.");
  });

  it("leaves an English sentence byte-identical when its values are Latin", async () => {
    await initI18n("en");
    applyLocale("en");

    // The reason isolation is conditional. If this changed, every existing assertion in the suite
    // that reads rendered English would have to learn about invisible characters.
    const rendered = i18n.t("a11y.dice_result", { first: 3, second: 5, total: 8 });
    expect(rendered).toBe("Rolled 3 and 5, total 8.");
    expect(stripIsolates(rendered)).toBe(rendered);
  });

  it("isolates a Hebrew value inside an English sentence", async () => {
    await initI18n("en");
    applyLocale("en");

    const rendered = i18n.t("dossier.title", { name: "רותי" });
    expect(rendered).toBe(`${FSI}רותי${PDI}'s properties`);
  });
});
