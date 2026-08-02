/**
 * The two things every spec in this directory needs: a started game, and a language.
 *
 * Kept deliberately thin. An e2e helper that grows assertions of its own becomes a place where a
 * test passes because the helper was lenient, and the whole point of this surface is that it
 * measures rather than infers.
 */

import { expect, type Locator, type Page } from "@playwright/test";

import { DIRECTION, type Locale } from "../src/i18n/direction";

/** The bot levels the setup screen offers, as the engine names them. */
export type BotLevel = "easy" | "normal" | "hard";

/**
 * The seed every spec deals from unless it says otherwise.
 *
 * One constant rather than a literal per spec, because "the same seed deals the same game" is the
 * property these specs lean on and a second number is a second game nobody chose.
 */
export const DEFAULT_SEED = 424242;

/** A rectangle, as Playwright reports it. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Start a two-player game and wait for the board.
 *
 * Driven through the real setup screen rather than by seeding a URL, because "can a person get from
 * the setup form to a board" is itself a claim worth checking once per run — and because the game id
 * only exists after the POST, so there is nothing to seed.
 *
 * A fixed seed so the deal is the same every run. The rest of these specs measure geometry, and
 * geometry should not depend on which square a token happens to be standing on.
 */
export async function startGame(
  page: Page,
  options: {
    readonly ruleset?: "universal" | "kids";
    /**
     * Seats to hand to a bot, by zero-based row, with the level to play at (MON-707).
     *
     * The setup screen's per-seat controls are a `human`/`bot` radio pair and a level `<select>` that
     * only exists once "bot" is chosen, so this is two gestures in order rather than one. Selected by
     * the input's `value` — the engine's own vocabulary — for the same reason as the rule set above:
     * the visible label is translated and this helper has just changed the language.
     */
    readonly bots?: readonly { readonly seat: number; readonly level: BotLevel }[];
    /** A different deal, for a spec that needs one. Defaults to {@link DEFAULT_SEED}. */
    readonly seed?: number;
    /**
     * Fill the form in this language rather than in English (MON-707).
     *
     * Defaults to `"en"` because most specs assert on English labels. The smoke passes `"he"`, and the
     * point of the option is that the *setup* happens in Hebrew too: "one smoke per locale" is a
     * weaker claim if the first screen was always filled in in English and the language changed
     * afterwards. Every selector below is structural or keyed on an input's `value`, so both work.
     */
    readonly locale?: Locale;
    /**
     * The table's house rules (MON-712), when a spec cares.
     *
     * Omitted, the form is left exactly as it opens — which is the point of the default: a spec that
     * says nothing about auctions is testing the game a player gets without touching anything.
     */
    readonly auctions?: {
      readonly enabled: boolean;
      readonly minimum?: "list_price" | "none";
    };
  } = {},
): Promise<void> {
  await page.goto("/");

  // The product opens in **Hebrew** (see `main.tsx`), so a spec that reads English labels has to ask
  // for English first. Done here rather than in each spec because it is a property of the app, not of
  // any one test — and asserted on its own in `locale.spec.ts`, so switching here cannot hide a
  // regression in what the app opens in.
  await switchTo(page, options.locale ?? "en");

  // Structural rather than `getByLabel("Name")`: the label is translated, and this helper has to be
  // able to fill the form in either language. The seat rows are the one `<ol>` with a testid, and each
  // row's only text box is its name field.
  const seats = page.getByTestId("setup-seats").getByRole("listitem");
  await expect(seats.first()).toBeVisible();
  for (const [index, name] of ["Ruti", "Dan"].entries()) {
    await seats.nth(index).locator('input[type="text"]').fill(name);
  }

  // The rule set, when a spec cares which one. Selected by the input's `value` — the engine's own
  // `RulesetName` — rather than by the visible label, which is translated and would tie the choice
  // to the language this helper has just changed. Same reason as `switchTo`'s locale radio below.
  if (options.ruleset !== undefined) {
    await page.locator(`label:has(input[name$="-ruleset"][value="${options.ruleset}"])`).click();
  }

  if (options.auctions !== undefined) {
    // Structural and keyed on the input's `value`, like the rule set above: the labels are
    // translated and this helper fills the form in either language.
    const wanted = options.auctions.enabled ? "on" : "off";
    await page.locator(`label:has(input[name$="-auctions"][value="${wanted}"])`).click();
    if (options.auctions.minimum !== undefined) {
      const floor = `label:has(input[name$="-auction-minimum"][value="${options.auctions.minimum}"])`;
      await expect(page.locator(floor)).toBeVisible();
      await page.locator(floor).click();
    }
  }

  for (const bot of options.bots ?? []) {
    const row = seats.nth(bot.seat);
    await row.locator('label:has(input[name$="-kind"][value="bot"])').click();
    // The level picker is mounted by the choice above, so it is waited for rather than assumed. It is
    // also the *first* `<select>` in the row, ahead of the pronoun picker — asserted by reading the
    // option back after selecting, which would fail loudly if the two ever swapped places.
    const level = row.locator("select").first();
    await expect(level).toBeVisible();
    await level.selectOption(bot.level);
    await expect(level).toHaveValue(bot.level);
  }

  /*
    The seed, and a bug this helper had until MON-707.

    Its docstring promises "a fixed seed so the deal is the same every run", and it was not doing it.
    The seed field moved behind an "advanced" disclosure that is **closed by default**, so
    `getByLabel("Seed")` resolved to a hidden input, `isVisible()` was false, and the fill was skipped
    in silence. Every spec in this directory has been playing an unseeded game — which is invisible in
    the specs that measure geometry and is exactly the wrong foundation for a smoke that plays turns.

    So: open the disclosure, fill the field, and **assert the value took**. A silently unseeded run is
    the failure mode this whole block exists to prevent, and it cannot be prevented by a call that is
    allowed to do nothing.
  */
  const advanced = page.locator("details").first();
  await advanced.locator("summary").click();
  const seed = advanced.locator('input[type="number"]');
  await expect(seed).toBeVisible();
  await seed.fill(String(options.seed ?? DEFAULT_SEED));
  await expect(seed).toHaveValue(String(options.seed ?? DEFAULT_SEED));

  await page.locator('button[type="submit"]').click();
  await expect(page.getByTestId("board-grid")).toBeVisible();
}

/**
 * Turn the flourish off, once, for a spec that is about the game rather than the animation.
 *
 * Not a convenience: a chit under a running animation is a *moving* element and Playwright refuses to
 * act on one, so a spec that skipped this would be flaky in a way that looks like a product bug and
 * is not. The switch is the product's own remembered preference (MON-701), so this is a player's
 * gesture and not a test hook.
 */
export async function skipAnimations(page: Page): Promise<void> {
  const skip = page.getByTestId("skip-animations").first();
  if ((await skip.getAttribute("aria-pressed")) !== "true") {
    await skip.click();
  }
}

/**
 * The moves a helper is willing to make, as **command kinds** rather than as button labels.
 *
 * Deliberately a *subset* of what the bar offers. It buys rather than declining, because declining
 * sends the square to auction under the universal rules and an auction is an unclosable phase this
 * helper has no business steering; and it never touches `declare_bankruptcy`, for the obvious reason.
 * Every press is still a button the engine offered — the helper decides nothing about legality, it
 * only prefers the quiet path through a game.
 *
 * Kinds, not names, because the MON-707 smoke plays the same game in Hebrew: `data-command-kind` is
 * the engine's own vocabulary and the accessible name is a translation of it.
 */
export const QUIET_KINDS: readonly string[] = [
  "roll_dice",
  "buy_property",
  "end_turn",
  // Both ways out of jail. `use_jail_card` first in the list is not an ordering — the loop presses
  // whichever chit the bar puts first — but a game that reaches the jail square and has neither of
  // these in the subset simply stops there, which is what MON-707 found this loop doing on turn 9.
  "use_jail_card",
  "pay_jail_fine",
  "roll_for_jail",
];

/** Every quiet chit currently on the bar, as one locator. */
export function quietMoves(page: Page): Locator {
  return page.locator(
    QUIET_KINDS.map((kind) => `#kesef-actions [data-command-kind="${kind}"]:visible`).join(", "),
  );
}

/**
 * Answer an auction, if one is up and this seat may act in it (MON-707).
 *
 * A bot that declines a purchase sends the square to auction, and an auction is an **unclosable
 * phase**: the bar behind the panel offers only `place_bid`, `withdraw_from_auction` and whatever
 * portfolio moves are legal, none of which are in {@link QUIET_KINDS}. So a helper that plays a game
 * with a bot in it has to answer one, or the game stops on turn two — which is exactly what the first
 * MON-707 smoke did.
 *
 * **Withdrawing first, bidding as the fallback.** Withdrawal is terminal: the lot goes to whoever is
 * still bidding and the phase ends in one gesture. It is only offered while it is this seat's turn to
 * bid, though, and `AuctionPanel` reads that off `legal_commands` rather than guessing — so when it is
 * absent and a bid is not, bidding is the way out, at the minimum the panel opens on. Either way the
 * auction strictly progresses, so it terminates.
 *
 * Returns `false` when there is nothing here for this seat to do, which is a real state: the *other*
 * seat is bidding, and the caller should wait rather than press.
 */
export async function answerAnyAuction(page: Page): Promise<boolean> {
  for (const testId of ["auction-withdraw", "auction-place-bid"]) {
    const control = page.getByTestId(testId);
    if ((await control.count()) === 0) {
      continue;
    }
    /*
      `isDisabled` with an explicit timeout, and treating a timeout as "disabled".

      Without the timeout this line **hangs**: `isDisabled()` defaults to waiting indefinitely for the
      element, and an auction footer re-renders between the `count()` above and this call whenever
      another seat bids — so the locator that existed a millisecond ago does not, and the wait never
      ends. It cost two ninety-second timeouts in the MON-707 suite before it was understood, and it is
      the sort of thing that only shows up under load, which is the worst way to find it.
    */
    const unavailable = await control.isDisabled({ timeout: 1_000 }).catch(() => true);
    if (unavailable) {
      continue;
    }
    // Both presses are given a **short** timeout and allowed to miss. These controls are only up while
    // it is this seat's turn to bid, and a bot bidding against it re-renders the footer out from under
    // the press — the same reason `playQuietly` tolerates a vanishing chit. Two seconds rather than
    // five, because the caller loops: a long timeout here multiplies by the move budget, which is how
    // the first version of this helper turned a stalled auction into a fifteen-minute test.
    await control.click({ timeout: 2_000 }).catch(() => undefined);
    // Terminal moves ask for confirmation, using the same predicate the action bar uses. A bid below
    // half the bidder's cash does not, so the confirmation is answered when it is there and not waited
    // for when it is not.
    const confirm = page.getByTestId("auction-confirm");
    if ((await confirm.count()) > 0) {
      await confirm.click({ timeout: 2_000 }).catch(() => undefined);
    }
    return true;
  }
  return false;
}

/** The turn number the banner is showing, or 0 before there is one. */
export async function turnNumber(page: Page): Promise<number> {
  const text = (await page.getByTestId("turn-banner").textContent()) ?? "";
  return Number(/\d+/.exec(text)?.[0] ?? "0");
}

/**
 * Play the quiet path until `stop` says so, or until the move budget runs out.
 *
 * Written as "press the first quiet move, then look again" rather than as a fixed sequence, because
 * the bar is **rebuilt from `legal_commands` after every command**: a locator resolved before a round
 * trip points at a node React has since replaced, and a fixed script also assumes which decisions a
 * seeded game will present. A chit that vanishes underneath the press is not a failure — the loop
 * re-reads the bar and carries on.
 *
 * Returns `true` when `stop` was satisfied. The caller asserts on that rather than on a wall clock:
 * there is no `waitForTimeout` anywhere in this file.
 */
export async function playQuietly(
  page: Page,
  stop: () => Promise<boolean>,
  budget = 80,
): Promise<boolean> {
  const moves = quietMoves(page);
  /**
   * How many auction presses in a row this loop will make before treating the phase as stuck.
   *
   * Bounded separately from the move budget because an auction is the one place where a press can
   * legitimately not change anything — the control is only live on this seat's bidding turn — and an
   * unbounded retry there is a loop that spends the whole budget on one lot.
   */
  let auctionPresses = 0;
  for (let attempt = 0; attempt < budget; attempt += 1) {
    if (await stop()) {
      return true;
    }
    // An auction covers the bar with an unclosable panel, so it is answered before anything else is
    // looked at — see `answerAnyAuction`.
    if (auctionPresses < 12 && (await answerAnyAuction(page))) {
      auctionPresses += 1;
      continue;
    }
    if ((await moves.count()) === 0) {
      /*
        Nothing to press *yet*, which is two very different situations and the reason this is a wait
        rather than a `return`.

        1. **It is a bot's turn.** The human seat has no legal commands at all while the engine is
           playing another seat, and the bar is correctly empty. The moves come back on their own
           when the bot is done, over the event socket (MON-304). A loop that gave up here would end
           every game with a bot in it on the bot's first turn — which is exactly what the MON-707
           smoke did until this was fixed, and it looked like "rent never happened".
        2. **The engine wants something outside the quiet subset** — an auction, a trade. Nothing here
           should be steering that, so this is as far as the helper can honestly play.

        Waiting on the locator distinguishes them without a `waitForTimeout`: case 1 resolves, case 2
        times out and the loop reports whatever `stop` says.
      */
      // Generous, because the thing being waited for is a *bot* finishing its turn against a real
      // engine over a real socket, and the suite runs several browsers against one server. Long
      // enough that load cannot turn a working product into a failure; still a wait on a condition,
      // so a game that is genuinely stuck costs this once and not per move.
      const returned = await moves
        .first()
        .waitFor({ state: "attached", timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      if (!returned) {
        return await stop();
      }
    }
    await moves
      .first()
      .click({ timeout: 5_000 })
      .catch(() => undefined);
    // An ordinary move went through, so the auction allowance starts again: a long game may meet
    // several lots, and the cap is against one of them spinning rather than against there being many.
    auctionPresses = 0;
  }
  return await stop();
}

/** Play until the game has reached `throughTurn`, to lay down a log worth walking. */
export async function playTurns(page: Page, throughTurn: number): Promise<void> {
  await skipAnimations(page);
  await playQuietly(page, async () => (await turnNumber(page)) >= throughTurn, 40);
}

/**
 * Switch the page's language and wait until the document agrees.
 *
 * Waits on `<html lang>` and `<html dir>` because `changeLanguage` is a promise: without the wait a
 * measurement taken straight afterwards can read the previous render. This is a *precondition*, not
 * an assertion — the specs that matter measure boxes, since a check on `dir` would be satisfied by
 * the same line of `applyLocale` that sets it (G-F32).
 */
export async function switchTo(page: Page, locale: Locale): Promise<void> {
  // The product has two locale controls on two screens, and this helper has to work on both. The
  // game chrome carries `<LocaleSwitch>` (a button group); the setup screen carries a form radio,
  // because a language choice made while filling in a form belongs to the form. Both write through
  // `useLocale`, so whichever is on screen produces the same result — which is the property that
  // makes trying one and falling back to the other sound rather than sloppy.
  const chromeSwitch = page.getByTestId(`locale-${locale}`);
  if ((await chromeSwitch.count()) > 0) {
    await chromeSwitch.click();
  } else {
    // The setup screen's radios are real inputs kept `sr-only` inside a clickable `<label>`, so that
    // arrow keys work and the focus ring lands on the card a player can see. `.check()` fails their
    // actionability for exactly that reason — the input has no box. Clicking the label is what a
    // person does, and it is what activates the input.
    //
    // Selected by the input's `value`, which is the locale code, rather than by the visible endonym:
    // the group's legend is itself translated, so a name-based lookup would depend on the language
    // this call is trying to change.
    await page.locator(`label:has(input[name$="-locale"][value="${locale}"])`).click();
  }
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(page.locator("html")).toHaveAttribute("dir", DIRECTION[locale]);
}

/** A locator's box, failing loudly rather than returning null. */
export async function rectOf(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox();
  expect(box, "element has no box — it is not laid out").not.toBeNull();
  return box as Rect;
}

/**
 * Measure the same element in both languages, in one page.
 *
 * Returns `[english, hebrew]`. The order matters: English first, so a test that fails has the
 * baseline in the left-hand side of the diff.
 */
export async function inBothLocales<T>(
  page: Page,
  measure: () => Promise<T>,
): Promise<readonly [T, T]> {
  await switchTo(page, "en");
  const english = await measure();
  await switchTo(page, "he");
  const hebrew = await measure();
  return [english, hebrew];
}
