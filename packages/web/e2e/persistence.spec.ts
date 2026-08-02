/**
 * The two things the product promises to *keep*, checked through the browser (MON-704, MON-706, MON-707).
 *
 * Both are already covered against a fake edge in the Vitest suite, and both have a claim in them that a
 * fake cannot answer:
 *
 * 1. **The save is a real file, written by the browser.** `SaveGameButton.test.tsx` asserts the bytes
 *    the component hands to its port; `App.test.tsx` asserts the loader posts what it was given. Neither
 *    one ever writes a file and reads it back, and between them sits the browser's own download and the
 *    `<input type="file">` that picks it up.
 * 2. **A mute survives a reload.** `mute.ts` writes `localStorage`, and its unit tests write
 *    `localStorage` directly to prove the reader honours it. That is the read half. The write half —
 *    that the toggle in the chrome persists, in a real browser, and that the value is picked up on the
 *    next page load rather than after a hydration paint — needs two page loads.
 *
 * The save/load test below documents a **product limitation it found**, and says so where it asserts it.
 * See `docs/A11Y_AUDIT.md`.
 */

import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { playTurns, skipAnimations, startGame, switchTo, turnNumber } from "./helpers";

test.describe("saving and loading a game", () => {
  test("writes a real save file, and the picker answers with the server's own key", async ({
    page,
  }) => {
    test.slow();
    await startGame(page);
    await playTurns(page, 3);

    const turnBefore = await turnNumber(page);
    expect(turnBefore, "the game did not get far enough to be worth saving").toBeGreaterThan(1);

    // --- the write half, through the browser's own download -----------------
    // `SaveGameButton` hands the bytes to a port that is the browser in production and a fake in
    // Vitest. This is the only place the real one runs.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("save-game").click(),
    ]);
    // Named after the turn the *server* says it captured, which is the turn it would restore to.
    expect(download.suggestedFilename()).toMatch(/^kesef-street-.*-turn-\d+\.json$/);
    const file = await download.path();
    expect(file, "the browser produced no file").not.toBeNull();

    // And it is a real save rather than a projection: the deck order and the RNG are in it, which is
    // the one payload in the product that carries hidden information (ADR-008 §2). Read here, because a
    // download that produced valid JSON with nothing useful in it would satisfy every other assertion.
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(saved)).toContain("schema_version");
    expect(saved["game_id"]).toBe(new URL(page.url()).searchParams.get("game"));
    expect(saved["turn_number"]).toBe(turnBefore);
    expect(saved["rng"], "the save carries no RNG, so it cannot reproduce the game").toBeDefined();

    // --- the read half -----------------------------------------------------
    await page.getByRole("button", { name: "New game" }).click();
    await expect(page.getByTestId("setup-seats")).toBeVisible();
    expect(
      new URL(page.url()).searchParams.get("game"),
      "the game id is still in the URL",
    ).toBeNull();

    await page.locator('input[type="file"]').setInputFiles(file);

    /*
      **This is a finding, not an assertion working around a flake.**

      Leaving a game in the UI does not end it on the *server* — the session is still there, holding this
      save's `game_id` — so `POST /games/load` answers `409 error.game_already_exists`
      (`api.py::_create`). A player who saves and then loads in the same sitting cannot restore; the only
      way through today is a server that has forgotten the game.

      Whether that is right is a product decision — does a load replace the live session, mint a new id,
      or ask? — so it is filed in `docs/A11Y_AUDIT.md` as a follow-up rather than decided by an
      accessibility audit. What this pins is the behaviour that *is* decided, and the two halves of it
      that would be defects: the refusal is the server's own key rendered as a sentence rather than a
      blank screen or a leaked key, and the picker is still there afterwards, because the retry is the
      picker.
    */
    await expect(page.getByTestId("load-save-error")).toContainText(
      "There's already a game with that name.",
    );
    await expect(page.locator('input[type="file"]')).toBeAttached();
    await expect(page.getByText("error.game_already_exists")).toHaveCount(0);
    // And a player who cannot restore can still start a game, which is the difference between a
    // limitation and a dead end. The submit is disabled on a blank form — that is form state, not the
    // refusal — so the check fills a name and watches it come back.
    const seats = page.getByTestId("setup-seats").getByRole("listitem");
    await seats.nth(0).locator('input[type="text"]').fill("Ruti");
    await seats.nth(1).locator('input[type="text"]').fill("Dan");
    await expect(page.locator('button[type="submit"]')).toBeEnabled();
  });

  test("keeps the loader reachable, and translated, on a Hebrew setup screen", async ({ page }) => {
    // A save carries its own board and rule set, so loading is reachable from a setup screen in either
    // language. The picker's label is translated, which is why this is checked rather than assumed —
    // `startGame` finds the input structurally for exactly that reason.
    await startGame(page, { locale: "he" });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("save-game").click(),
    ]);
    const file = await download.path();

    await page.getByRole("button", { name: "משחק חדש" }).click();
    await expect(page.getByTestId("setup-seats")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "he");

    const picker = page.locator('input[type="file"]');
    await expect(picker).toBeAttached();
    await picker.setInputFiles(file);

    // The same keyed refusal, rendered from the Hebrew catalogue. A brace on screen would be a
    // placeholder the sentence names and the call site does not pass; Latin script would be an English
    // fallback leaking through. This is the one assertion in the file about *sentences*, and it is here
    // because a refusal nobody can read is the same as no refusal.
    const note = page.getByTestId("load-save-error");
    await expect(note).toBeVisible();
    await expect(note).not.toContainText("{{");
    expect(await note.textContent(), "Latin text in a Hebrew refusal").not.toMatch(/[A-Za-z]{3,}/);
  });
});

test.describe("the mute switch", () => {
  test("survives a reload of the same game", async ({ page }) => {
    await startGame(page);
    const mute = page.getByTestId("mute-sound");
    // `aria-pressed` reflects *muted*, matching the label "Mute sound" — see `MuteToggle.tsx`.
    await expect(mute).toHaveAttribute("aria-pressed", "false");

    await mute.click();
    await expect(mute).toHaveAttribute("aria-pressed", "true");

    // The same URL, so the game is rehydrated rather than abandoned — the id lives in the query string
    // for exactly this reason (`App.tsx`). Everything in memory is gone; only `localStorage` is left.
    await page.reload();
    await expect(page.getByTestId("board-grid")).toBeVisible();
    await expect(
      page.getByTestId("mute-sound"),
      "the mute did not survive the reload",
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("is independent of the animation preference beside it", async ({ page }) => {
    // The two switches sit together in the chrome and answer different questions, and they are backed by
    // two separate module-level stores with two separate storage keys. A single "quiet mode" flag would
    // satisfy every test either of them has on its own.
    await startGame(page);
    await skipAnimations(page);
    await expect(page.getByTestId("skip-animations").first()).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("mute-sound")).toHaveAttribute("aria-pressed", "false");

    await page.reload();
    await expect(page.getByTestId("board-grid")).toBeVisible();
    await expect(page.getByTestId("skip-animations").first()).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("mute-sound")).toHaveAttribute("aria-pressed", "false");
  });

  test("is reachable and pressed in Hebrew as well", async ({ page }) => {
    await startGame(page);
    await switchTo(page, "he");
    const mute = page.getByTestId("mute-sound");
    await mute.click();
    await expect(mute).toHaveAttribute("aria-pressed", "true");
    // The label moved with the language; the state did not move with the label.
    await expect(mute).not.toHaveText("Mute sound");
  });
});
