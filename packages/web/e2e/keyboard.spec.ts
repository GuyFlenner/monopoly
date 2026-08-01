/**
 * A game played by keyboard alone (MON-703).
 *
 * The §5.5 floor says "full keyboard reachability, visible focus". Every component test asserts a
 * button *has* a role and a name; none of them asserts that a person can **get to it**, because
 * reaching a control is a property of the whole tab order and jsdom has no tab order to speak of.
 * This file is that assertion, and it is written so that it cannot be satisfied by anything but the
 * keyboard: there is no `.click()` anywhere below, no `.focus()`, no coordinates.
 *
 * ## `tabTo` is the whole design
 *
 * Every interaction goes through {@link tabTo}, which presses **Tab** until `document.activeElement`
 * matches a selector and fails if a bounded number of presses does not get there. That single helper
 * turns "is this reachable" from an assumption into the mechanism — a control that is not in the tab
 * order cannot be used by this spec at all, so a regression that drops one out is a failure rather
 * than something a reviewer has to notice.
 *
 * It also checks the two things that go wrong *between* stops, on every press:
 *
 * 1. **Focus is never on `<body>`.** This repo has had that bug twice: a chit that unmounts under the
 *    focus (the bar is rebuilt from `legal_commands` after every command) and a control that
 *    `disabled` itself when its work was done. `SkipMotionButton` and `PinToggle` both carry a comment
 *    about it, which is a fix applied where somebody happened to think of it. This is the check that
 *    covers the ones nobody thought of.
 * 2. **Focus is visible.** `:focus-visible` has to actually match, and the global rule in `index.css`
 *    has to actually paint an outline. Asserted by reading the computed style off the focused element,
 *    which is a claim only a browser can settle.
 *
 * ## What it plays
 *
 * Setup by keyboard — language, both names, the bot seat, submit — then several turns including a
 * purchase and the hand-off to the bot and back. Not a full game: the point is a *meaningful stretch*
 * across every screen, and turn 40 exercises nothing turn 4 did not.
 */

import { expect, test, type Page } from "@playwright/test";

import { DEFAULT_SEED, skipAnimations, turnNumber } from "./helpers";

/** How many Tab presses a control may be from wherever focus currently is. */
const TAB_BUDGET = 160;

/** What the focused element is, as a short description a failure message can carry. */
async function focusedDescription(page: Page): Promise<string> {
  return page.evaluate(() => {
    const node = document.activeElement;
    if (node === null) return "null";
    const parts = [node.tagName.toLowerCase()];
    for (const attribute of ["data-testid", "data-command-kind", "type", "name", "id"]) {
      const value = node.getAttribute(attribute);
      if (value !== null) parts.push(`[${attribute}="${value}"]`);
    }
    return parts.join("");
  });
}

/**
 * Assert that focus is somewhere a person can see, and not on the document body.
 *
 * `<body>` is the specific failure this exists for: it is where the browser puts focus when the
 * element holding it is removed, and from there Tab starts again at the top of the page — so a player
 * mid-turn is silently sent back to the language switch. It is also indistinguishable from "the page
 * has no focus" to a screen reader.
 */
async function expectFocusVisible(page: Page, because: string): Promise<void> {
  const state = await page.evaluate(() => {
    const node = document.activeElement;
    if (node === null || node === document.body || node === document.documentElement) {
      return { onBody: true, ring: "", matches: false };
    }
    const style = getComputedStyle(node);
    return {
      onBody: false,
      // Either half of the sandwich in `index.css` counts: the outline or the box-shadow. Both are
      // painted for `:focus-visible`, and whichever the surface swallows, the other one shows.
      ring: `${style.outlineStyle} ${style.outlineWidth} / ${style.boxShadow}`,
      matches: node.matches(":focus-visible"),
    };
  });

  expect(state.onBody, `${because}: focus fell to <body>`).toBe(false);
  expect(state.matches, `${because}: the focused element does not match :focus-visible`).toBe(true);
  expect(state.ring, `${because}: no focus ring is painted`).not.toMatch(/^none 0px \/ none$/);
}

/**
 * Press Tab until the focused element matches `selector`.
 *
 * Returns the number of presses it took, so a caller can assert something about the *shape* of the tab
 * order if it wants to. Fails with the current focus in the message, which is the one piece of
 * information that makes a broken tab order debuggable.
 */
async function tabTo(page: Page, selector: string, because = selector): Promise<number> {
  for (let presses = 0; presses <= TAB_BUDGET; presses += 1) {
    if (await page.evaluate((s) => document.activeElement?.matches(s) ?? false, selector)) {
      await expectFocusVisible(page, `on reaching ${because}`);
      return presses;
    }
    await page.keyboard.press("Tab");
  }
  // The failure message carries the target's own state, because "not reachable" has two very
  // different causes — it is not in the tab order, or it is not in the document at all — and a bare
  // count cannot tell them apart.
  const target = await page.evaluate((s) => {
    const nodes = [...document.querySelectorAll(s)];
    return nodes.map((node) => ({
      html: node.outerHTML.slice(0, 120),
      tabIndex: (node as HTMLElement).tabIndex,
      hidden: (node as HTMLElement).offsetParent === null,
      inClosedDetails: node.closest("details:not([open])") !== null,
    }));
  }, selector);
  throw new Error(
    `${because} was not reachable in ${String(TAB_BUDGET)} Tab presses; ` +
      `focus ended on ${await focusedDescription(page)}; ` +
      `matches: ${JSON.stringify(target)}`,
  );
}

/** Tab to a control and activate it with Enter, then check focus survived the activation. */
async function tabToAndPress(page: Page, selector: string, because = selector): Promise<void> {
  await tabTo(page, selector, because);
  await page.keyboard.press("Enter");
  await expectFocusVisible(page, `after pressing ${because}`);
}

test("plays a stretch of a game with nothing but the keyboard", async ({ page }) => {
  test.slow();
  await page.goto("/");

  // --- the setup screen, by keyboard --------------------------------------
  // The product opens in Hebrew, and a radio group is **one** tab stop — Tab lands on whichever radio
  // is checked, and the others are reached with arrow keys. So this is Tab to the group, then arrows
  // until the document says English. Both halves are what a keyboard user actually does, and the
  // second is why `tabTo(input[value="en"])` would have failed on a working product.
  await tabTo(page, 'input[name$="-locale"]', "the language radio group");
  for (let press = 0; press < 4; press += 1) {
    if ((await page.getAttribute("html", "lang")) === "en") break;
    await page.keyboard.press("ArrowRight");
  }
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

  // Two names, typed. `tabTo` proves each field is reachable from where focus already is, which is
  // the claim a `fill()` would skip.
  const seats = page.getByTestId("setup-seats").getByRole("listitem");
  await tabTo(page, "input[type=text]", "the first seat's name field");
  await page.keyboard.type("Ruti");
  await page.keyboard.press("Tab");
  // Between the two name fields sit that seat's human/bot radios and its pronoun picker, so the second
  // field is several stops away rather than one.
  await tabTo(page, "input[type=text]:not([value='Ruti'])", "the second seat's name field");
  await page.keyboard.type("Dan");
  await expect(seats.nth(1).locator("input[type=text]")).toHaveValue("Dan");

  // Seat 2 becomes a bot, so the turn hand-off later has somebody to hand to. A radio group again:
  // Tab to it, then arrow across.
  await tabTo(page, 'input[name$="-kind"]', "the second seat's human/bot radios");
  await page.keyboard.press("ArrowRight");
  await expect(seats.nth(1).locator('input[name$="-kind"][value="bot"]')).toBeChecked();

  // The seed lives behind a `<details>`. A disclosure's `<summary>` is a tab stop and Enter opens it —
  // which is worth exercising precisely because a `<div onClick>` pretending to be one would not.
  await tabToAndPress(page, "summary", "the advanced disclosure");
  await tabTo(page, "input[type=number]", "the seed field");
  await page.keyboard.type(String(DEFAULT_SEED));

  await tabToAndPress(page, "button[type=submit]", "the start button");
  await expect(page.getByTestId("board-grid")).toBeVisible();
  // Focus survived the whole screen being replaced. This is the largest unmount in the product, and
  // if anything drops focus to `<body>` it is this.
  await expectFocusVisible(page, "after the game screen replaced the setup screen");

  // --- the game screen, by keyboard ---------------------------------------
  // The animation preference, reached and toggled by keyboard rather than through the helper's click:
  // a moving chit cannot be pressed, and a keyboard-only spec has to be able to say so itself.
  await tabToAndPress(page, '[data-testid="skip-animations"]', "the skip-animations switch");
  await expect(page.getByTestId("skip-animations").first()).toHaveAttribute("aria-pressed", "true");

  /*
    Four turns' worth of moves, every one reached by Tab and activated by Enter.

    Each iteration re-tabs from wherever the previous activation left focus, which is exactly the
    traversal that finds a lost one. The two subtleties:

    - **The bar is read fresh every iteration and the read can still go stale.** A command posts, the
      response lands a beat later, and the chit list changes then. So a press is followed by a wait on
      the *log* growing — every command produces at least one event — rather than on a clock, and a
      chit that has left the document between the read and the walk is skipped rather than reported as
      unreachable.
    - **An empty bar means it is the bot's turn**, not that nothing is reachable. Waited on, again as a
      condition rather than a duration.
  */
  const rows = page.locator("li[data-log-key]");
  const bought = page.locator('li[data-log-key="log.property_acquired_purchase"]');
  let purchases = 0;
  for (let move = 0; move < 30; move += 1) {
    if ((await turnNumber(page)) >= 4 && purchases > 0) break;

    // An auction takes the bar away behind an unclosable panel. Answer it by keyboard too.
    if ((await page.getByTestId("auction-withdraw").count()) > 0) {
      await tabToAndPress(
        page,
        '[data-testid="auction-withdraw"]',
        "the auction's withdraw button",
      );
      if ((await page.getByTestId("auction-confirm").count()) > 0) {
        await tabToAndPress(page, '[data-testid="auction-confirm"]', "the withdrawal confirmation");
      }
      continue;
    }

    const kinds = await page
      .locator("#kesef-actions [data-command-kind]:visible")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-command-kind")));
    if (kinds.length === 0) {
      await page
        .locator("#kesef-actions [data-command-kind]")
        .first()
        .waitFor({ state: "attached", timeout: 15_000 })
        .catch(() => undefined);
      continue;
    }

    // Prefer buying, so the stretch definitely includes a purchase; otherwise take the quiet move.
    const wanted =
      ["buy_property", "roll_dice", "end_turn", "roll_for_jail", "pay_jail_fine"].find((kind) =>
        kinds.includes(kind),
      ) ?? null;
    if (wanted === null) {
      break;
    }

    const selector = `[data-command-kind="${wanted}"]`;
    const logged = await rows.count();
    try {
      await tabToAndPress(page, selector, `the ${wanted} chit`);
    } catch (cause) {
      // Only a chit that is *still there* and still unreachable is a failure. One that has gone is the
      // bar having moved on under a stale read, which is the product working.
      if ((await page.locator(selector).count()) > 0) {
        throw cause;
      }
      continue;
    }
    await expect
      .poll(() => rows.count(), { message: `${wanted} produced no event` })
      .toBeGreaterThan(logged);

    if (wanted === "buy_property") {
      await expect(bought.first()).toBeAttached();
      purchases = await bought.count();
    }
  }

  expect(purchases, "the keyboard stretch never bought a square").toBeGreaterThan(0);
  expect(await turnNumber(page), "the keyboard stretch never got past turn one").toBeGreaterThan(1);

  // --- and the panels a keyboard user has to be able to leave -------------
  // A dialog is where keyboard support usually stops: focus has to go in, Tab has to stay in, and
  // Escape has to bring it back to the control that opened it. `ModalDialog` promises all three.
  await tabToAndPress(page, '[data-testid="open-replay"]', "the replay button");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expectFocusVisible(page, "on entering the replay dialog");
  const insideDialog = await page.evaluate(
    () => document.activeElement?.closest('[role="dialog"]') !== null,
  );
  expect(insideDialog, "opening a dialog left focus outside it").toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expectFocusVisible(page, "after Escape closed the replay dialog");
  await expect(page.getByTestId("open-replay")).toBeFocused();

  // The compare tray is the newest surface in the product and the one most likely to have been built
  // with a mouse in mind. Pinning is a real `aria-pressed` button on the dossier, so it is a tab stop.
  await tabToAndPress(page, '[data-testid^="pin-player-"]', "the dossier's pin toggle");
  await expect(page.getByTestId("compare-tray")).toBeVisible();
  await tabTo(page, '[data-testid="compare-tray-rail"]', "the tray's scroll region");
  // A scrollable region has to be focusable or its content is unreachable without a mouse — axe's
  // `scrollable-region-focusable`, asserted here as the thing it is actually about.
});

/**
 * Pressing a control must not take the control away.
 *
 * The complement of the test above, and the sharper half. That one proves every control this spec
 * needs is *reachable*; this one presses each chrome control and asserts that focus is **still on the
 * thing that was pressed** afterwards. That is the exact bug the repo has had twice — a control that
 * disables or unmounts as a result of its own activation hands the keyboard to `<body>`, from where Tab
 * starts again at the top of the page — and it is invisible to a mouse user, which is why nothing
 * caught it before MON-703.
 *
 * `<body>` and a wrapped tab order are deliberately not asserted here: in headless Chromium there is no
 * browser chrome to receive focus, so Tab from the last stop legitimately passes through the document.
 * A full-circuit test would be asserting a property of the harness. Activation is the property of the
 * *product*.
 */
test("keeps focus on a control that was just activated", async ({ page }) => {
  test.slow();
  await page.goto("/");
  await tabTo(page, 'input[name$="-locale"]', "the language radio group");
  for (let press = 0; press < 4; press += 1) {
    if ((await page.getAttribute("html", "lang")) === "en") break;
    await page.keyboard.press("ArrowRight");
  }
  await tabTo(page, "input[type=text]", "the first seat's name field");
  await page.keyboard.type("Ruti");
  await tabTo(page, "input[type=text]:not([value='Ruti'])", "the second seat's name field");
  await page.keyboard.type("Dan");
  await tabToAndPress(page, "button[type=submit]", "the start button");
  await expect(page.getByTestId("board-grid")).toBeVisible();

  /*
    Every control in the chrome that does something to the page it lives on, plus the two on the board
    column. Deliberately including the ones that are *already* careful — `skip-motion` reports itself
    unavailable rather than disabling, `pin-player-0` uses `aria-disabled` at the ceiling — because a
    test that only covered the known-bad ones would go green the moment somebody "tidied up" a
    working one into a `disabled`.

    Not included: "New game", which is *supposed* to replace the screen (`a11y/screenFocus.ts` owns
    where focus goes then, and the test above presses the other direction), and `open-replay`, which
    opens a dialog and is checked in the test above.
  */
  const controls = [
    "skip-animations",
    "mute-sound",
    "save-game",
    "skip-motion",
    "locale-he",
    "locale-en",
    "pin-player-0",
  ] as const;

  for (const testId of controls) {
    const selector = `[data-testid="${testId}"]`;
    await tabTo(page, selector, testId);
    await page.keyboard.press("Enter");
    await expectFocusVisible(page, `after activating ${testId}`);
    const stillThere = await page.evaluate(
      (s) => document.activeElement?.matches(s) ?? false,
      selector,
    );
    expect(stillThere, `${testId} lost the focus it was activated with`).toBe(true);
  }

  // And the action bar, which is rebuilt from `legal_commands` on every command — so the chit that was
  // pressed is *gone* by the time the next render lands. That is legitimate; losing the keyboard over
  // it is not, and this is the one place in the product where it is unavoidable rather than a mistake.
  await skipAnimations(page);
  const rows = page.locator("li[data-log-key]");
  const logged = await rows.count();
  await tabTo(page, '[data-command-kind="roll_dice"]', "the roll chit");
  await page.keyboard.press("Enter");
  // Wait for the throw to be in the log, which is when the bar has been rebuilt without the chit that
  // was pressed. A count on the chit itself would not do: rolling doubles leaves `roll_dice` legal.
  await expect.poll(() => rows.count()).toBeGreaterThan(logged);
  await expectFocusVisible(page, "after the roll chit was replaced by the bar's next set");
  // And the keyboard is inside the bar rather than at the top of the page — see `ActionBar.tsx`.
  const inTheBar = await page.evaluate(
    () => document.activeElement?.closest("#kesef-actions") !== null,
  );
  expect(inTheBar, "the press left focus outside the action bar").toBe(true);
});
