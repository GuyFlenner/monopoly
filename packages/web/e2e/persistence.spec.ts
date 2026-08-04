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
 * The save/load tests below once documented a **product limitation they found** — saving and loading in
 * one sitting was refused, because leaving a game does not end its session. That was `docs/A11Y_AUDIT.md`
 * D1, deferred as a product decision. It is decided: the refusal asks the player which game they meant
 * (MON-714, ADR-011), and both answers are exercised here, in both languages.
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
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      state: Record<string, unknown>;
      events: unknown[];
    };
    expect(Object.keys(saved.state)).toContain("schema_version");
    expect(saved.state["game_id"]).toBe(new URL(page.url()).searchParams.get("game"));
    expect(saved.state["turn_number"]).toBe(turnBefore);
    expect(
      saved.state["rng"],
      "the save carries no RNG, so it cannot reproduce the game",
    ).toBeDefined();
    // And the log, since ADR-011 — the half of a session a bare `GameState` had no room for, and the
    // reason a restored game can show "What's happened" (MON-715).
    expect(
      saved.events.length,
      "the save carries no events, so a restored game would have no history",
    ).toBeGreaterThan(0);

    // --- the read half -----------------------------------------------------
    await page.getByRole("button", { name: "New game" }).click();
    await expect(page.getByTestId("setup-seats")).toBeVisible();
    expect(
      new URL(page.url()).searchParams.get("game"),
      "the game id is still in the URL",
    ).toBeNull();

    await page.locator('input[type="file"]').setInputFiles(file);

    /*
      **This was the product's one deferred decision, and it is decided (MON-714, ADR-011).**

      Leaving a game in the UI does not end the session, so the id in this save is still live and the
      first attempt is refused with `409 error.game_already_exists`. What used to be a dead end is now
      a question: the refusal is still the server's own key rendered as a sentence, and under it are the
      two answers a player can actually mean.

      The whole exchange is pinned, because each half fails differently — a refusal rendered as a
      leaked key is one defect, and two buttons wired to nothing is another.
    */
    await expect(page.getByTestId("load-save-error")).toContainText(
      "There's already a game with that name.",
    );
    await expect(page.getByText("error.game_already_exists")).toHaveCount(0);
    await expect(page.getByTestId("load-save-conflict")).toBeVisible();

    // "Replace the game in progress": the save takes over the id it already carries, so the game comes
    // back at the turn it was saved on and the URL does not change.
    await page.getByTestId("load-save-replace").click();
    await expect(page.getByTestId("board-grid")).toBeVisible();
    expect(new URL(page.url()).searchParams.get("game")).toBe(saved.state["game_id"]);
    expect(await turnNumber(page), "the restored game is not at the turn it was saved on").toBe(
      turnBefore,
    );

    // And the history came back with it (MON-715). A restored game's log used to start empty, which is
    // what a bare `GameState` in the file cost. Found by its accessible name, the way `dossier.spec`
    // finds it — the log carries no test id and does not need one.
    await expect(
      page.getByRole("region", { name: "What's happened" }).getByRole("listitem").first(),
      "a restored game has no history",
    ).toBeVisible();
  });

  test("can seat a save beside the game that is still running", async ({ page }) => {
    test.slow();
    // The other answer to the same question: "Load as a separate game" leaves the live game alone and
    // seats the file under a minted id, so both are playable and the URL names the new one.
    await startGame(page);
    await playTurns(page, 2);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("save-game").click(),
    ]);
    const file = await download.path();
    expect(file, "the browser produced no file").not.toBeNull();
    const original = new URL(page.url()).searchParams.get("game");

    await page.getByRole("button", { name: "New game" }).click();
    await page.locator('input[type="file"]').setInputFiles(file);
    await expect(page.getByTestId("load-save-conflict")).toBeVisible();
    await page.getByTestId("load-save-copy").click();

    await expect(page.getByTestId("board-grid")).toBeVisible();
    const copied = new URL(page.url()).searchParams.get("game");
    expect(copied, "the copy was not given an id of its own").not.toBe(original);

    // The game that was left is still being played, which is the whole difference between this answer
    // and the other one. Reached by its own URL, because that is how a player would go back to it.
    await page.goto(`/?game=${String(original)}`);
    await expect(page.getByTestId("board-grid")).toBeVisible();
    await expect(page.getByTestId("game-error")).toHaveCount(0);
  });

  test("lets a player cancel the choice and still start a game", async ({ page }) => {
    // The difference between a question and a trap. Cancelling clears the refusal *and* the question,
    // and the picker underneath is what a player does next.
    await startGame(page);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("save-game").click(),
    ]);
    const file = await download.path();

    await page.getByRole("button", { name: "New game" }).click();
    await page.locator('input[type="file"]').setInputFiles(file);
    await page.getByTestId("load-save-cancel").click();

    await expect(page.getByTestId("load-save-conflict")).toHaveCount(0);
    await expect(page.getByTestId("load-save-error")).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toBeAttached();
    // The submit is disabled on a blank form — that is form state, not the refusal — so the check
    // fills a name and watches it come back.
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

    // And the question the refusal now asks, in the same language (MON-714). Three keys were added to
    // both catalogues; an English fallback leaking through here is a Hebrew-speaking family being
    // asked, in a language they may not read, which game to end.
    const question = page.getByTestId("load-save-conflict");
    await expect(question).toBeVisible();
    await expect(question).not.toContainText("{{");
    expect(await question.textContent(), "Latin text in the Hebrew conflict question").not.toMatch(
      /[A-Za-z]{3,}/,
    );

    // The answer works from the Hebrew screen too, which is the part a translation check alone would
    // not catch: a button that reads correctly and posts nothing is still a dead end.
    await page.getByTestId("load-save-replace").click();
    await expect(page.getByTestId("board-grid")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "he");
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
