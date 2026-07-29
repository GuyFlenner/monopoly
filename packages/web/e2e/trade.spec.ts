/**
 * The human-vs-human trade round trip (MON-422).
 *
 * `App.test.tsx` proves the review panel renders a frame's contents against a fake edge. What it
 * cannot prove is that a *real* engine ever produces such a frame from a real offer, or that
 * answering it resolves the interrupt — the two halves of the flow that only exist end to end. Before
 * MON-422 the recipient could not see the offer at all, so this is the spec that says the feature
 * works rather than that the component renders.
 *
 * Driven entirely through the UI: propose from one seat, answer from the other. No seeded state.
 */

import { expect, test } from "@playwright/test";

import { startGame } from "./helpers";

test.describe("proposing and answering a trade", () => {
  test("the recipient sees the offer's contents and can accept it", async ({ page }) => {
    await startGame(page);

    // Open the builder from the action bar. `propose_trade` is offered on the acting seat's turn
    // whenever trading is enabled, so it is there from turn one with nothing owned.
    await page.getByRole("button", { name: "Offer a trade" }).click();
    const builder = page.getByRole("dialog");
    await expect(builder.getByRole("heading", { name: "Offer a trade" })).toBeVisible();

    // Put cash on the proposer's side. Cash needs nothing owned, so this works on turn one — which
    // keeps the spec about the trade flow rather than about acquiring property first.
    await builder.getByRole("button", { name: "Add 10" }).first().click();

    // The send button is hidden until a side carries something (the MON-410 amendment), so its
    // appearance is itself the signal that the draft is non-empty.
    const send = builder.getByRole("button", { name: "Send this offer" });
    await expect(send).toBeVisible();
    await send.click();

    // The engine now holds a trade-review interrupt, and the panel must come back in review mode
    // showing what was offered. This is the assertion the whole item exists for.
    const review = page.getByRole("dialog");
    await expect(review.getByRole("heading", { name: "An offer for you" })).toBeVisible();
    await expect(review.getByTestId("offer-cash")).toHaveText("10");
    await expect(review.getByTestId("trade-accept")).toBeVisible();
    await expect(review.getByTestId("trade-decline")).toBeVisible();

    await review.getByTestId("trade-accept").click();

    // Answering resolves the interrupt, so the panel goes and the board is playable again. A panel
    // that stayed would mean the response was rejected — which is what reading the acting seat
    // instead of the frame's recipient would have caused.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("board-grid")).toBeVisible();
  });

  test("declining also resolves the offer", async ({ page }) => {
    await startGame(page);

    await page.getByRole("button", { name: "Offer a trade" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Add 10" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Send this offer" }).click();

    const review = page.getByRole("dialog");
    await expect(review.getByTestId("trade-decline")).toBeVisible();
    await review.getByTestId("trade-decline").click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Declining is not a failure, so nothing should be reporting one.
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
