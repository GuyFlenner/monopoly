import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { kidsKey, KIDS_PREFIX, useCopy } from "./copy";
import commonEn from "./locales/common.en.json";
import commonHe from "./locales/common.he.json";

/**
 * Kids Mode's wording layer, and the two ways it could quietly stop working.
 *
 * 1. **It could stop preferring the twin**, which looks like nothing at all: every label still
 *    renders, in the ordinary wording, and no test that only asserts "some English appears" notices.
 *    So the assertions below name both strings and check which one came back.
 * 2. **It could throw.** `missingKeyHandler` raises under test by design, so a key with no twin must
 *    take the fallback path rather than asking i18next for `kids.<key>` and blowing up the screen.
 *
 * Parity between the two catalogues is `tests/test_locale_parity.py`'s job. What is checked here is
 * the half that file cannot see: that a twin exists in *both* languages for every key this layer is
 * expected to simplify, since a Hebrew game falling back to English wording would be invisible to a
 * key-set diff (the catalogues would still agree — they would agree on having no twin).
 */

type Catalogue = Record<string, unknown>;

function leaf(catalogue: Catalogue, key: string): string | undefined {
  const found = key.split(".").reduce<unknown>((node, part) => {
    return typeof node === "object" && node !== null
      ? (node as Record<string, unknown>)[part]
      : undefined;
  }, catalogue);
  return typeof found === "string" ? found : undefined;
}

/** Every `kids.*` leaf English declares, as the ordinary key it is a twin of. */
function twinnedKeys(): readonly string[] {
  const kids = (commonEn as Catalogue)["kids"];
  const walk = (node: unknown, prefix: string): string[] => {
    if (typeof node !== "object" || node === null) {
      return [];
    }
    return Object.entries(node).flatMap(([part, value]) =>
      typeof value === "string" ? [`${prefix}${part}`] : walk(value, `${prefix}${part}.`),
    );
  };
  return walk(kids, "");
}

describe("kidsKey", () => {
  it("names the twin of an ordinary key", () => {
    expect(kidsKey("actionbar.label")).toBe(`${KIDS_PREFIX}actionbar.label`);
  });

  it("refuses a namespaced key, which has no twin to name", () => {
    // `kids.board-classic:…` would name a namespace that does not exist, and a square's name is a
    // proper noun anyway — there is no simpler word for Boardwalk.
    expect(kidsKey("board-classic:tile.classic.go")).toBeNull();
  });

  it("refuses a key that is already a twin, so the prefix cannot stack", () => {
    expect(kidsKey(`${KIDS_PREFIX}actionbar.label`)).toBeNull();
  });
});

describe("useCopy", () => {
  it("is exactly `t` outside a kids game, twin or no twin", () => {
    const { result } = renderHook(() => useCopy(false));
    expect(result.current("actionbar.label")).toBe(leaf(commonEn, "actionbar.label"));
    expect(result.current("actionbar.label")).not.toBe(leaf(commonEn, "kids.actionbar.label"));
  });

  it("prefers the simpler twin in a kids game", () => {
    const { result } = renderHook(() => useCopy(true));
    const simple = leaf(commonEn, "kids.actionbar.label");
    expect(simple).toBeDefined();
    expect(result.current("actionbar.label")).toBe(simple);
  });

  it("falls back rather than throwing for a key with no twin", () => {
    const { result } = renderHook(() => useCopy(true));
    // `label.net_worth` is deliberately untwinned: "net worth" is what the figure is called.
    expect(() => result.current("label.net_worth")).not.toThrow();
    expect(result.current("label.net_worth")).toBe(leaf(commonEn, "label.net_worth"));
  });

  it("interpolates into the twin, not only into the ordinary key", () => {
    const { result } = renderHook(() => useCopy(true));
    // The bail figure has to survive the swap, or Kids Mode reads "Pay and get out" with no amount.
    expect(result.current("action.pay_jail_fine", { amount: 50 })).toContain("50");
  });

  it("hands a namespaced key straight through", () => {
    const { result } = renderHook(() => useCopy(true));
    expect(result.current("board-classic:tile.classic.go")).toBe("GO");
  });
});

describe("the twins themselves", () => {
  it("twins keys that actually exist, so a typo cannot hide as a fallback", () => {
    const orphans = twinnedKeys().filter((key) => leaf(commonEn, key) === undefined);
    expect(orphans, "kids.* twins of keys nothing renders").toEqual([]);
  });

  it("says something different from the key it twins", () => {
    // A twin identical to its original is catalogue weight with no reader benefit, and it would let
    // a half-finished simplification pass as done.
    const same = twinnedKeys().filter(
      (key) => leaf(commonEn, key) === leaf(commonEn, `${KIDS_PREFIX}${key}`),
    );
    expect(same, "kids.* twins identical to the ordinary wording").toEqual([]);
  });

  it("exists in Hebrew for every key it exists in English (MON-604)", () => {
    // The failure this catches is a Hebrew kids game reading its buttons in adult Hebrew while the
    // key-set diff stays clean — both catalogues would agree, on the absence.
    const missing = twinnedKeys().filter(
      (key) => leaf(commonHe, `${KIDS_PREFIX}${key}`) === undefined,
    );
    expect(missing, "kids.* twins with no Hebrew").toEqual([]);
  });
});
