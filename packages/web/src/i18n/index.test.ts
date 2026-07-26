import { describe, expect, it } from "vitest";

import { i18n } from "./index";

/**
 * GAP §3 (Major) / G-F17: a missing catalogue key must be loud. A `console.error` nobody
 * watches is not a gate, and the handler was previously disabled under Vitest by
 * construction (`import.meta.env.DEV` alone). This pins the failure mode so a regression
 * shows up as a red test, not a silently rendered raw key in some future screen.
 */
describe("i18n missing-key handling", () => {
  it("throws when asked to translate a key that does not exist in any catalogue", () => {
    expect(() => i18n.t("does.not.exist")).toThrow(/missing key/i);
  });
});
