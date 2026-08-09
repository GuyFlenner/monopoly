/**
 * Taking a seat, from the guest's side (ADR-012, MON-906).
 *
 * The affordance is small; what is easy to get wrong is **when it appears**. Offered to somebody
 * who already holds a seat, it is a second way to do something they have done. Withheld from a
 * guest who followed a link, the audit's finding is still true from their side: a board they can
 * see and cannot join. Offered at a full table it is a control that cannot work — `SetupScreen`'s
 * rule, which this file applies here.
 *
 * Both locales are exercised, because the picker is the first thing a Hebrew-speaking joiner reads
 * and a heading that only exists in English is a screen with a hole in it.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiError, type GameView, type PlayerView, type SeatClaimView } from "@/api";
import { applyLocale } from "@/i18n";
import { expectAxeClean } from "@/test/axe";
import { makePlayer, makeView } from "@/test/fixtures";

import { SeatClaim } from "./SeatClaim";

const PLAYERS: readonly PlayerView[] = [
  makePlayer(0, { name: "Ruti" }),
  makePlayer(1, { name: "Dan" }),
];

const BOTH_FREE: readonly SeatClaimView[] = [
  { player: 0, claimed: false },
  { player: 1, claimed: false },
];

function renderPicker(
  overrides: {
    readonly claims?: readonly SeatClaimView[];
    readonly seated?: boolean;
    readonly onClaim?: (player: number) => Promise<GameView>;
  } = {},
) {
  const onClaim = overrides.onClaim ?? vi.fn().mockResolvedValue(makeView());
  const result = render(
    <SeatClaim
      claims={overrides.claims ?? BOTH_FREE}
      players={PLAYERS}
      seated={overrides.seated ?? false}
      onClaim={onClaim}
    />,
  );
  return { ...result, onClaim };
}

describe("the seat picker", () => {
  it("offers every free seat by the name a parent typed at the setup screen", () => {
    renderPicker();

    expect(screen.getByTestId("seat-claim")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ruti/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Dan/ })).toBeInTheDocument();
  });

  it("does not offer a seat somebody has already taken", () => {
    renderPicker({
      claims: [
        { player: 0, claimed: true },
        { player: 1, claimed: false },
      ],
    });

    expect(screen.queryByRole("button", { name: /Ruti/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Dan/ })).toBeInTheDocument();
  });

  it("renders nothing at all once this browser speaks for a seat", () => {
    // The host holds a secret from the moment they created the game, so a hotseat player never sees
    // this — which is the whole of "hotseat is unchanged" on this side of the wire.
    renderPicker({ seated: true });

    expect(screen.queryByTestId("seat-claim")).not.toBeInTheDocument();
  });

  it("renders nothing when every seat is taken, rather than an empty picker", () => {
    renderPicker({
      claims: [
        { player: 0, claimed: true },
        { player: 1, claimed: true },
      ],
    });

    expect(screen.queryByTestId("seat-claim")).not.toBeInTheDocument();
  });

  it("claims the seat that was pressed, and only that one", async () => {
    const onClaim = vi.fn().mockResolvedValue(makeView());
    renderPicker({ onClaim });

    await userEvent.click(screen.getByTestId("claim-seat-1"));

    await waitFor(() => {
      expect(onClaim).toHaveBeenCalledTimes(1);
      expect(onClaim).toHaveBeenCalledWith(1);
    });
  });

  it("renders the server's keyed refusal when the seat went to somebody else first", async () => {
    // `error.seat_taken` is the answer to two people pressing the same chair at once, and it is the
    // sentence that turns a dead button into an instruction. No retry control: the retry is the row
    // of other seats, which is still on screen.
    const onClaim = vi.fn().mockRejectedValue(new ApiError(409, "error.seat_taken", { player: 1 }));
    renderPicker({ onClaim });

    await userEvent.click(screen.getByTestId("claim-seat-1"));

    expect(await screen.findByTestId("seat-claim-error")).toHaveTextContent(
      "Somebody is already in that seat. Choose a free one.",
    );
  });

  it("reads in Hebrew too, because a joiner's first screen is this one", async () => {
    applyLocale("he");
    try {
      renderPicker();

      // Awaited, because `changeLanguage` resolves on a later tick — see `LocaleSwitch.test.tsx`.
      await waitFor(() => {
        expect(screen.getByTestId("seat-claim")).toHaveTextContent(
          "מי מכם משחק? אפשר לבחור מושב פנוי ולהצטרף.",
        );
      });
    } finally {
      applyLocale("en");
    }
  });

  it("is reachable by keyboard and clean to axe", async () => {
    const onClaim = vi.fn().mockResolvedValue(makeView());
    const { container } = renderPicker({ onClaim });

    // Tab lands on the first seat and Enter presses it — ordinary buttons, so this is a property of
    // *not* having reinvented one. A div with an onClick would fail here and nowhere else.
    await userEvent.tab();
    expect(screen.getByTestId("claim-seat-0")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(onClaim).toHaveBeenCalledTimes(1);
      expect(onClaim).toHaveBeenCalledWith(0);
    });

    await expectAxeClean(container);
  });
});
