/**
 * The static build, played in a real browser, against the real Python engine (MON-805).
 *
 * ## Why this is a separate surface
 *
 * Everything else in the repository can be green while this is broken, and that is not a
 * hypothetical: the Vitest suite drives the local transport over a *faked* Python side, and the
 * parity suite drives the real Python side with no browser. Between the two sits everything that
 * only WebAssembly can get wrong — micropip refusing a wheel whose `Requires-Python` the runtime
 * does not satisfy, a dependency that has no wasm build, the board JSON missing from a wheel, a
 * relative asset URL that resolves differently under a Pages sub-path. None of that is visible to a
 * mock and none of it is visible to pytest.
 *
 * ## Why it is not in the default `playwright test`
 *
 * It needs a `vite build` to have happened, and it downloads a CPython build from a CDN. Both make
 * it the wrong shape for the PR gate — `e2e/` measures layout against a dev server in seconds. So
 * this lives in its own directory with its own config (`playwright.pages.config.ts`) and its own
 * script (`npm run test:e2e:pages`), and the deploy workflow runs it against the artifact it is
 * about to publish.
 *
 * ## What it claims
 *
 * That a person can open the URL and take a turn, and that the *engine* was what answered. The
 * second half is the load-bearing one: a board rendered from a stub would satisfy the first.
 */

import { expect, test } from "@playwright/test";

// One test, generously timed. The first load fetches a CPython build and two wheels; a per-test
// timeout tuned for a dev server would fail this on a cold CDN cache and say nothing useful.
test.describe.configure({ timeout: 240_000 });

test("a turn can be played with no server behind the page", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto("/");

  // The loading state is a real screen, not a blank page: a few megabytes of interpreter takes long
  // enough that a white rectangle reads as a broken deployment.
  await expect(page.getByText(/פייתון|Python/)).toBeVisible();

  // The app opens in Hebrew. English first, because the assertions below are written in it.
  await page
    .locator('label:has(input[name$="-locale"][value="en"])')
    .click({ timeout: 240_000 });
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  // `/boards` and `/rulesets` were answered by `kesef_engine.board.loader`, out of the JSON inside
  // the wheel — so a board picker with squares in it is already proof the engine loaded and read its
  // own data. 40 of them is the classic board.
  const names = page.getByLabel("Name");
  await names.nth(0).fill("Ruti");
  await names.nth(1).fill("Dan");
  await page.getByLabel("Seed").fill("424242");
  await page.getByRole("button", { name: "Start the game" }).click();

  const board = page.getByTestId("board-grid");
  await expect(board).toBeVisible();
  expect(await board.locator("[data-tile-index]").count()).toBe(40);

  // The game id is in the URL, which is what makes a reload rehydrate rather than abandon.
  expect(new URL(page.url()).searchParams.get("game")).toBeTruthy();

  // A turn. The button exists because `legal_commands` said so — the UI renders what it is handed
  // (ADR-005), so a roll button on screen is the engine's answer and not this page's opinion.
  await page.getByRole("button", { name: /roll/i }).click();

  // Dice, in the live region the engine's events narrate. A stub could paint a board; only a reducer
  // produces a roll that adds up.
  const announcement = page.getByRole("status").or(page.locator("[aria-live]"));
  await expect(announcement.filter({ hasText: /rolled/i }).first()).toBeVisible();

  // And the event log, which is fed from the same `LoggedEvent` frames the WebSocket carries in the
  // server build — here delivered by the fake socket out of the session log.
  await expect(page.getByText(/rolled/i).first()).toBeVisible();

  // A Python traceback, a 404 for a wheel or a micropip refusal all arrive here. The page can look
  // fine and still have failed at something; this is what notices.
  expect(consoleErrors.filter((text) => /Traceback|micropip|PythonError/i.test(text))).toEqual([]);
});
