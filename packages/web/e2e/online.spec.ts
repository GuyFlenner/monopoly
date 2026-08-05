/**
 * Two machines, one game — the claim MON-901 exists to make true.
 *
 * Every other spec in this directory drives **one** browser. That is the right shape for layout, for
 * RTL geometry, for a panel's keyboard path; it is the wrong shape for the only question online play
 * actually asks, which is whether a move made *there* shows up *here* without anybody pressing
 * anything. A single context cannot fail that test, because there is nothing for the state to be
 * shared with.
 *
 * So this spec opens a second browser context — a separate cookie jar, a separate `localStorage`, a
 * separate socket, which is as close to a second machine as a test can get without a second machine —
 * and asserts across the gap.
 *
 * ## Joining is a URL, and that already worked
 *
 * `App.tsx` routes on `?game=<id>` (`GAME_PARAM`), so "share the link" *is* the join mechanism and no
 * lobby had to be invented for this. The second context navigates to the first's URL and is in the
 * game. What does not exist yet is any notion of **which seat is yours**: the engine offers every
 * legal command to whoever asks, so both contexts can act for either player. That is a real MON-901
 * design question and it is deliberately not smuggled in here — this spec asserts the transport, and
 * says so rather than pretending seat ownership exists.
 *
 * ## Why the assertion is on the *watcher*
 *
 * The interesting direction is the one nothing else covers: context B presses nothing at all. Its log
 * row can only arrive over its own WebSocket, pushed by the server because context A acted. If the
 * event stream were broken — the socket rejected, the subscription dropped, the cursor wrong — this is
 * the assertion that notices, and none of the single-context specs would.
 */

import { expect, test, type Page } from "@playwright/test";

import { skipAnimations, startGame, turnNumber } from "./helpers";

/** Log rows by the key that produced them, so the spec reads the same in either locale. */
function logRows(page: Page, key: string) {
  return page.locator(`li[data-log-key="${key}"]`);
}

test.describe("two clients, one game", () => {
  test("a move made in one browser reaches the other over its own socket", async ({
    page,
    browser,
  }) => {
    // A real game, a real server, two real sockets. Slower than the suite default for the same reason
    // the smoke is: this is a round trip through uvicorn, not a render.
    test.slow();

    // --- the host starts a game -------------------------------------------
    await startGame(page, { locale: "en" });
    await skipAnimations(page);
    const shareUrl = page.url();
    expect(shareUrl, "the game id belongs in the URL — that is the whole join mechanism").toContain(
      "game=",
    );

    // --- the guest opens the same link, from a clean context ---------------
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    try {
      await guest.goto(shareUrl);
      await skipAnimations(guest);

      // The guest is looking at the *same* game, not a new one: same id, same turn.
      expect(new URL(guest.url()).searchParams.get("game")).toBe(
        new URL(shareUrl).searchParams.get("game"),
      );
      await expect(guest.getByTestId("board-grid")).toBeVisible();
      expect(await turnNumber(guest)).toBe(await turnNumber(page));

      // Nothing has been rolled yet, in either window. Asserted so the row counted below cannot be
      // one that was already on the board when the guest arrived — which would pass without any
      // socket at all, since a joining client replays the log it fetches.
      await expect(logRows(guest, "log.dice_rolled_move")).toHaveCount(0);

      // --- the host acts; the guest presses nothing --------------------------
      await page.locator('#kesef-actions [data-command-kind="roll_dice"]').first().click();

      /*
        The guest's row can only have arrived over the guest's own WebSocket. Waiting on the row
        rather than on a duration keeps it a condition; the timeout is raised past the suite's ten
        seconds because this is a command round trip plus a fan-out to a second subscriber, which is
        real product behaviour and not a wait to be shortened.
      */
      await expect(logRows(guest, "log.dice_rolled_move").first()).toBeVisible({ timeout: 20_000 });

      // And the two windows agree about the game afterwards, which is the property that makes the
      // shared state worth having: a socket that delivered the event but left the guest's projection
      // behind would satisfy the assertion above and still be broken.
      await expect
        .poll(async () => turnNumber(guest), { timeout: 20_000 })
        .toBe(await turnNumber(page));
    } finally {
      await guestContext.close();
    }
  });
});
