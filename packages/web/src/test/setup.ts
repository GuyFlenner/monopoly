import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll } from "vitest";

import { initI18n } from "../i18n";

// Components render translated text, so the catalogues must exist before the first test.
// Tests assert on English strings; Hebrew parity is covered by tests/test_locale_parity.py
// and by the Playwright RTL smoke.
beforeAll(async () => {
  await initI18n("en");
});

afterEach(() => {
  cleanup();
});
