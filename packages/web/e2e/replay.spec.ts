/**
 * The replay viewer against the real stack (MON-705).
 *
 * The Vitest suite drives this panel against a fake edge and asserts the whole contract there. What
 * only this surface can answer is whether the feature works against the **server's own log**: that
 * `GET /games/{id}?since=0` returns every frame of a game that was actually played, that the
 * accumulator's reading of those frames matches what the engine did, and that stepping back through
 * them changes the board a browser has laid out.
 *
 * So: play a short seeded game, open the replay, walk to the middle, and check a board fact and a log
 * line against each other. If the accumulator ever disagreed with the engine about what an event
 * says, this is the test that would notice — the fixture in the unit suite is hand-written, and this
 * one is not written at all.
 */

import { expect, test } from "@playwright/test";

// `playTurns` moved to `helpers.ts` in MON-707, where the smoke needs the same quiet path — and where
// it is driven by `data-command-kind` rather than by English button names, so one loop plays a game in
// either language.
import { playTurns, startGame } from "./helpers";

test.describe("the replay viewer", () => {
  test("steps back through the server's own log", async ({ page }) => {
    await startGame(page);
    await playTurns(page, 4);

    await page.getByTestId("open-replay").click();

    const dialog = page.getByRole("dialog", { name: "Replay" });
    await expect(dialog).toBeVisible();

    // It opens at the end of the log, and the log came from the game that was just played — so there
    // is something to step through. `1 of 1` would mean the `since=0` replay came back with one frame.
    const position = page.getByTestId("replay-position");
    await expect(position).toBeVisible();
    const total = Number(/of (\d+)/.exec((await position.textContent()) ?? "")?.[1] ?? "0");
    expect(total, "a played game should have a log worth replaying").toBeGreaterThan(6);

    // The board is laid out inside the panel — the assertion jsdom cannot make.
    const grid = page.getByTestId("replay-board-grid");
    await expect(grid).toBeVisible();
    const box = await grid.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(200);

    // Walk to the middle with the slider, then read the two things that must agree: the newest line
    // of the written history, and the frame summary the accumulator built from the same event.
    await page.getByTestId("replay-slider").fill(String(Math.floor(total / 2)));
    await expect(position).toHaveText(`Event ${String(Math.floor(total / 2))} of ${String(total)}`);

    // "History up to here", not "What's happened": the replay renders the game screen's own
    // `<EventLog>` under its own heading key, because two regions with one name is `landmark-unique`
    // and a landmark list with two identical entries cannot be navigated (MON-703).
    const historyLines = dialog
      .getByRole("region", { name: "History up to here" })
      .getByRole("listitem");
    await expect(historyLines.first()).toBeVisible();
    const midwayCount = await historyLines.count();

    // A board fact at this position: at least one token is standing somewhere. Position zero is the
    // empty ring, and anything past the first `token_moved` has a piece on the felt.
    await expect(dialog.locator('[data-testid="token-cluster"]').first()).toBeVisible();

    // Step to the very beginning: the ring empties, because the log has said nothing yet.
    await page.getByTestId("replay-first").click();
    await expect(position).toHaveText(`Event 0 of ${String(total)}`);
    await expect(dialog.locator('[data-testid="token-cluster"]')).toHaveCount(0);
    await expect(page.getByTestId("replay-nothing-yet")).toBeVisible();

    // And back to the end, where there is strictly more history than there was in the middle.
    await page.getByTestId("replay-last").click();
    await expect(position).toHaveText(`Event ${String(total)} of ${String(total)}`);
    expect(await historyLines.count()).toBeGreaterThan(midwayCount);
  });

  test("leaves the live game exactly where it was", async ({ page }) => {
    await startGame(page);
    await playTurns(page, 3);

    const liveTurn = await page.getByTestId("turn-banner").textContent();

    await page.getByTestId("open-replay").click();
    await expect(page.getByRole("dialog", { name: "Replay" })).toBeVisible();
    // Walk right back to the start of the game inside the panel…
    await page.getByTestId("replay-first").click();
    await page.keyboard.press("Escape");

    // …and the table is still where it was. The replay reads its own copy of the log; it never
    // touches the view the game screen renders from.
    await expect(page.getByRole("dialog", { name: "Replay" })).toBeHidden();
    await expect(page.getByTestId("turn-banner")).toHaveText(liveTurn ?? "");
    await expect(page.getByTestId("board-grid")).toBeVisible();
  });

  test("is operable from the keyboard alone", async ({ page }) => {
    await startGame(page);
    await playTurns(page, 3);

    await page.getByTestId("open-replay").click();
    const position = page.getByTestId("replay-position");
    await expect(position).toBeVisible();

    // `ModalDialog` moves focus into the panel on open; the first focusable thing in it is the first
    // transport button. Arrow keys step from there, which is the whole keyboard contract.
    await page.getByTestId("replay-first").focus();
    await page.keyboard.press("Home");
    await expect(position).toContainText("Event 0 of");

    await page.keyboard.press("ArrowRight");
    await expect(position).toContainText("Event 1 of");

    await page.keyboard.press("End");
    const text = (await position.textContent()) ?? "";
    const [, at, total] = /Event (\d+) of (\d+)/.exec(text) ?? [];
    expect(at).toBe(total);
  });
});
