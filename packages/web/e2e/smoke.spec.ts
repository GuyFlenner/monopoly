/**
 * The smoke MON-707 asks for by name: **one full pass per locale**, against the real stack.
 *
 * > create game → roll → buy → rent event visible in the log → end turn → bot responds
 *
 * Thirty-one specs landed incrementally before this one, and every one of them is about a *part*: the
 * tray's geometry, the replay's accumulator, Kids Mode's comfort scale, the RTL board pin. None of them
 * plays a game. These do, in both languages, and they are the only specs in the directory that would
 * fail if the product were assembled correctly out of components that all work on their own.
 *
 * ## Why the chain is two tests per locale and not one
 *
 * Because the first six steps and the last one want **different tables**, and the first version of this
 * file learned that the expensive way.
 *
 * A bot seat is what "end turn → bot responds" needs. It is also what makes the rest slow and
 * non-deterministic: a bot that declines a purchase sends the square to auction, and an auction is an
 * unclosable phase whose controls are only live on one seat's bidding turn — so a spec that wants to
 * reach *rent* has to steer several auctions it has no business steering, and the run went from forty
 * seconds to fifteen minutes on one stuck lot. With two human seats and a spec that always buys,
 * `decline_purchase` is never sent, so **no auction can happen at all** and the walk to rent is short
 * and repeatable.
 *
 * So: the long chain plays two humans, and the hand-off plays a hard bot and asserts only the hand-off.
 * Between them every step MON-707 lists is covered, in both languages, and neither test pays for the
 * other's table.
 *
 * ## Why the assertions read `data-*` and not sentences
 *
 * Because the same spec runs in Hebrew. A chit's accessible name and a log line's text are both
 * translations; `data-command-kind` and `data-log-key` are the engine's own vocabulary, identical in
 * both languages by construction. So this file asserts **what happened** in a language-neutral way and
 * leaves **how it reads** to the spec written for that — `rtl.spec.ts` reads the Hebrew log and checks
 * for stray braces and leaked Latin, which is a claim about sentences and belongs there.
 *
 * Seat names are the exception, and deliberately: "Ruti" and "Dan" are Latin in both builds, which is
 * what makes "the bot rolled" readable without teaching this file any Hebrew.
 *
 * ## Determinism
 *
 * A fixed seed deals the same dice and the same card order every run — the RNG is part of the serialized
 * state (ADR-002). Animations are switched off through the product's own preference before anything is
 * pressed. There is no `waitForTimeout` and no wall-clock assertion below: every wait is on a
 * condition, and the play loops are bounded by a **move budget** rather than by a duration.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

import { playQuietly, skipAnimations, startGame, turnNumber } from "./helpers";

/** Log rows by the key that produced them, rather than by the sentence the key renders as. */
function logRows(page: Page, key: string): Locator {
  return page.locator(`li[data-log-key="${key}"]`);
}

/**
 * Where the game got to, for a failure message.
 *
 * Without this, a play loop that stops early reports "rent never happened", which is true and useless:
 * the interesting facts are which turn it reached and what the engine was asking for when it stopped.
 * A message that names those turns a re-run into a diagnosis.
 */
async function whereWeGotTo(page: Page): Promise<string> {
  const kinds = await page
    .locator("#kesef-actions [data-command-kind]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-command-kind")));
  const keys = await page
    .locator("li[data-log-key]")
    .evaluateAll((nodes) => [...new Set(nodes.map((node) => node.getAttribute("data-log-key")))]);
  return (
    `turn ${String(await turnNumber(page))}; offered [${kinds.join(", ")}]; ` +
    `log has [${keys.join(", ")}]`
  );
}

/**
 * Press one chit by command kind, tolerating the bar being rebuilt under the press.
 *
 * The bar is re-rendered from `legal_commands` whenever a response lands, so a chit that was there when
 * the locator resolved can be gone by the time Playwright acts on it — that is the product working, not
 * a flake. `playQuietly` has the same shape and the same reason. Each attempt either presses the chit or
 * plays one quiet move towards it; the attempt count is the failure condition, so a command the engine
 * genuinely never offers still fails loudly.
 */
async function press(page: Page, kind: string): Promise<void> {
  const chit = page.locator(`#kesef-actions [data-command-kind="${kind}"]`).first();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if ((await chit.count()) > 0) {
      const pressed = await chit
        .click({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (pressed) {
        return;
      }
      continue;
    }
    await playQuietly(page, async () => (await chit.count()) > 0, 4);
  }
  throw new Error(`the bar never offered ${kind} — ${await whereWeGotTo(page)}`);
}

for (const locale of ["en", "he"] as const) {
  test(`plays a game in ${locale}: create, roll, buy, rent in the log, end turn`, async ({
    page,
  }) => {
    // Several turns of a real game against a real engine over a real socket. Slower than the suite's
    // 30 s default, and `test.slow()` rather than a raised global timeout because every *other* spec
    // here should still fail fast if the app hangs.
    test.slow();

    // Two humans, so this spec makes every decision and no auction can occur — see the file docstring.
    await startGame(page, { locale });
    await skipAnimations(page);

    // --- create game --------------------------------------------------------
    // `startGame` waited on the grid; this is the claim that a *game* started rather than that a board
    // rendered — turn one, with the first seat to act.
    expect(await turnNumber(page)).toBe(1);
    await expect(page.getByTestId("turn-banner")).toContainText("Ruti");

    // --- roll ---------------------------------------------------------------
    await press(page, "roll_dice");
    // The throw is in the log, which means the command reached the engine and an event came back. The
    // dice tray alone would not prove that: it renders `state.dice`, and the log renders events.
    await expect(logRows(page, "log.dice_rolled_move").first()).toBeVisible();

    // --- buy ----------------------------------------------------------------
    /*
      Whether the *first* square is purchasable depends on the deal, so the loop plays the quiet path
      until Ruti has bought one. `property_acquired_purchase` is the engine's own event: the UI cannot
      manufacture it, and a bar that posted the wrong command would never produce it.

      Filtered to Ruti's purchase so that the deed assertion below has a card to look at — the aside
      shows one seat at a time, and "somebody bought something" would be satisfied by the other seat.
    */
    const bought = logRows(page, "log.property_acquired_purchase").filter({ hasText: "Ruti" });
    expect(
      await playQuietly(page, async () => (await bought.count()) > 0, 30),
      `Ruti never managed to buy a square in thirty moves — ${await whereWeGotTo(page)}`,
    ).toBe(true);

    // Ruti's card, chosen from the seat picker: the aside defaults to whichever seat is *acting*, and
    // asking for a particular one is the gesture spec §5.2 exists for — holdings are public, so any
    // seat's card is reachable on anybody's turn (MON-406).
    await page.getByRole("button", { name: "Ruti", exact: true }).first().click();
    const aside = page.locator('aside [data-testid="player-dossier"]');
    await expect(aside).toHaveAttribute("data-player", "0");
    // And the deed is on the buyer's own card, not only in the ledger. The dossier reads `tiles_owned`
    // off the projection, so this is the round trip closing rather than the log agreeing with itself.
    // The deed list is folded away on arrival (`dossier.spec.ts`), so this reads an attribute rather
    // than asserting visibility.
    await expect(aside.locator('[data-testid="deed-row"]').first()).toHaveAttribute(
      "data-tile",
      /\d/,
    );

    // --- rent charged, visible in the log -----------------------------------
    const rent = logRows(page, "log.rent_charged");
    expect(
      await playQuietly(page, async () => (await rent.count()) > 0, 90),
      `no rent was charged in ninety moves of a seeded game — ${await whereWeGotTo(page)}`,
    ).toBe(true);
    // Rent is the one figure the §5.5 floor says must be *explainable*, and the engine attaches the
    // explanation as `rent.note.*` sub-lines. A charge with no note is the MON-420 regression, and it is
    // the half of "rent is in the log" that a `toBeVisible` on the row would not notice.
    await expect(rent.first().locator("ul li").first()).toBeVisible();

    /*
      --- end turn -----------------------------------------------------------

      Asserted as a *consequence* rather than by a final press, and the distinction is deliberate.

      `end_turn` is in the quiet path, so reaching rent at all means the seat has changed hands
      repeatedly — and `log.turn_started` is the engine's own record of that, one row per turn. Nothing
      but an accepted `end_turn` produces it, so counting them is the same claim as pressing the chit.

      A final explicit press is *not* the right shape here, and trying it is how this was learned: by
      the time rent has been charged the acting seat can be in jail, where the engine legitimately
      offers `pay_jail_fine` and `roll_for_jail` and **not** `end_turn` — so a spec that insists on
      pressing it is asserting a rule the engine does not have. The deliberate hand-off, on a turn where
      it is unambiguously legal, is the bot test below.
    */
    const turns = await logRows(page, "log.turn_started").count();
    expect(turns, `the seat never changed hands — ${await whereWeGotTo(page)}`).toBeGreaterThan(1);
    expect(await turnNumber(page)).toBeGreaterThan(1);
  });

  test(`hands over to a hard bot in ${locale}, and the bot answers`, async ({ page }) => {
    // The last link in MON-707's chain, on the table that link needs: a bot seat. Short by design —
    // one hand-off — because everything before it is covered by the test above, on a table where a
    // bot's declined purchase cannot stall the walk in an auction.
    test.slow();
    await startGame(page, { locale, bots: [{ seat: 1, level: "hard" }] });
    await skipAnimations(page);

    await expect(page.getByTestId("turn-banner")).toContainText("Ruti");

    const botThrows = logRows(page, "log.dice_rolled_move").filter({ hasText: "Dan" });
    expect(await botThrows.count(), "the bot moved before it was its turn").toBe(0);

    const turnBefore = await turnNumber(page);
    await press(page, "roll_dice");
    await press(page, "end_turn");

    // The bot plays itself: its throw arrives over the event socket with nothing pressed in between.
    // Waiting on the log rather than on a duration is what keeps that deterministic — the moves land
    // when they land (MON-304 streams them rather than making the human wait).
    await expect
      .poll(() => botThrows.count(), { message: "the bot never took its turn" })
      .toBeGreaterThan(0);
    // And the turn came back, so the seat changed hands twice.
    await expect
      .poll(() => turnNumber(page), { message: "the bot never handed the turn back" })
      .toBeGreaterThan(turnBefore);
    await expect(page.getByTestId("turn-banner")).toContainText("Ruti");
  });
}
