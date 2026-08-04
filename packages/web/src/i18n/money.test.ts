/**
 * Money on screen (MON-720, GAP G-43).
 *
 * The owner's decision was two sentences — `$50` in English, `50 ₪` in Hebrew — and most of what can go
 * wrong with it is invisible in a screenshot: a symbol on the wrong side of the figure reads as a
 * different currency, a breaking space lets `50` and `₪` land on separate lines, and a
 * `toLocaleString` groups differently depending on which ICU the browser shipped.
 */

import { describe, expect, it } from "vitest";

import { CURRENCY, formatMoney } from "./money";
import { LOCALES } from "./direction";

describe("the decision", () => {
  it("puts the dollar before the figure and the shekel after it", () => {
    expect(formatMoney(50, "en")).toBe("$50");
    expect(formatMoney(50, "he")).toBe("50 ₪");
  });

  it("separates a Hebrew figure from its sign with a non-breaking space", () => {
    // A plain space lets `50` and `₪` fall on different lines in a 320 px column, which this product
    // commits to. Asserted on the code point, because the two are indistinguishable in a diff.
    expect(formatMoney(50, "he")).toContain(" ");
    expect(formatMoney(50, "he")).not.toContain(" ₪");
  });

  it("has a symbol for every language the product offers", () => {
    // The `Record<Locale, …>` makes this a compile error too. Kept as a runtime check for the same
    // reason `actions.test.ts` re-checks its table: the compile gate disappears the moment somebody
    // widens the key type.
    for (const locale of LOCALES) {
      expect(CURRENCY[locale].symbol, locale).not.toBe("");
    }
  });
});

describe("grouping", () => {
  it("separates thousands, which is what a starting pile looks like", () => {
    expect(formatMoney(1500, "en")).toBe("$1,500");
    expect(formatMoney(1500, "he")).toBe("1,500 ₪");
    expect(formatMoney(1234567, "en")).toBe("$1,234,567");
  });

  it("leaves anything under a thousand alone", () => {
    for (const amount of [0, 1, 4, 50, 999]) {
      expect(formatMoney(amount, "en"), String(amount)).not.toContain(",");
    }
    expect(formatMoney(0, "en")).toBe("$0");
    expect(formatMoney(1000, "en")).toBe("$1,000");
  });
});

describe("what the engine can hand it", () => {
  it("keeps a minus in front of the digits in both languages", () => {
    // `50-₪` would read as nonsense: the sign belongs to the number, not to the currency. Nothing in
    // the product renders a negative amount today — the engine forbids negative cash outside
    // `DEBT_SETTLEMENT` and a debt is shown as a positive figure owed — so this is defence, and it is
    // cheaper to state than to rediscover.
    expect(formatMoney(-50, "en")).toBe("-$50");
    expect(formatMoney(-1500, "he")).toBe("-1,500 ₪");
  });

  it("truncates rather than printing agorot the game has no concept of", () => {
    // Every amount in the engine is a whole number of units. A fraction reaching here is a defect
    // upstream; rounding it into a decimal place the rest of the product does not have would hide it.
    expect(formatMoney(50.7, "en")).toBe("$50");
    expect(formatMoney(50.2, "he")).toBe("50 ₪");
  });
});
