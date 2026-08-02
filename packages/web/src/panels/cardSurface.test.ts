/**
 * The card surface's three pure decisions (MON-709).
 *
 * ## The falsifier
 *
 * `cardBodyLanguage` is the one worth writing tests for, and its failure mode is invisible in the
 * language the reviewer reads in: a hardcoded `lang="en"` passes every English assertion, and every
 * Hebrew one too until `cards.he.json` lands — which it now has, and a hardcoded answer would mark
 * every Hebrew card as English, pronounced with English phonetics and laid out left-to-right inside
 * an RTL card. Replace the script test with a constant and the tests below go red.
 *
 * The order of the two script questions matters too, and the numerals are why: a Hebrew card that
 * mentions $50 contains strong-LTR runs, so "any Latin at all?" would call it English. There is a
 * test for exactly that string.
 */

import { describe, expect, it } from "vitest";

import { cardBodyLanguage, DECK_ICON, figureKey } from "./cardSurface";

describe("the deck's glyph", () => {
  it("names an outline per deck, and no colour", () => {
    // Colour is deliberately absent: the two decks are told apart by outline here, by border style
    // in the component, and by their names in words (spec §5.4).
    expect(DECK_ICON).toEqual({ chance: "spark", community_chest: "chest" });
  });
});

describe("the figure's sentence", () => {
  it("picks the verb from the sign, which is grammar rather than arithmetic", () => {
    expect(figureKey(50)).toBe("card_reveal.gained");
    expect(figureKey(-50)).toBe("card_reveal.paid");
  });

  it("says nothing at all for a card that moved no money", () => {
    // Not "0": a card with no figure gets no line, rather than a line reading zero.
    expect(figureKey(null)).toBeNull();
    expect(figureKey(0)).toBeNull();
  });
});

describe("what language the card's text turned out to be in", () => {
  const ENGLISH = "Advance to GO. Collect $200.";
  const HEBREW = "התקדמו להתחלה ואספו 200.";

  it("marks an English card inside a Hebrew game, because today that is what it is", () => {
    // The state of a card the Hebrew deck has not got, where i18next falls back. Unmarked, a screen
    // reader pronounces English with
    // Hebrew phonetics and the bidi algorithm throws the full stop to the wrong end of the line.
    expect(cardBodyLanguage(ENGLISH, "he")).toEqual({ lang: "en", dir: "ltr" });
  });

  it("marks nothing once the Hebrew catalogue lands — the same code, a different answer", () => {
    // The ordinary case since MON-506: the catalogue is Hebrew, and nothing had to be flipped.
    expect(cardBodyLanguage(HEBREW, "he")).toBeNull();
  });

  it("marks a Hebrew card shown in an English game, which is the mirror of the same bug", () => {
    expect(cardBodyLanguage(HEBREW, "en")).toEqual({ lang: "he", dir: "rtl" });
  });

  it("does not call a Hebrew card English for the sake of its numerals", () => {
    // "$50" and "10" are strong-LTR runs. Ask "any Latin?" first and this comes back English.
    expect(cardBodyLanguage("שלמו 50 על כל בית ו-100 על כל מלון.", "he")).toBeNull();
    expect(cardBodyLanguage("שלמו 50.", "en")).toEqual({ lang: "he", dir: "rtl" });
  });

  it("says nothing about a string with no language in it", () => {
    expect(cardBodyLanguage("50", "he")).toBeNull();
    expect(cardBodyLanguage("— 100 —", "en")).toBeNull();
  });

  it("treats an unknown locale as LTR rather than throwing", () => {
    expect(cardBodyLanguage(ENGLISH, "fr")).toBeNull();
    expect(cardBodyLanguage(HEBREW, "fr")).toEqual({ lang: "he", dir: "rtl" });
  });
});
