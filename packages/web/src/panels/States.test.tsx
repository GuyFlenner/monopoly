/**
 * The three states, and the four things about them that would be worth a bug report (MON-708).
 *
 * 1. **Every one renders from the catalogue.** A state that rendered a key, or nothing, is the
 *    "untranslated errors" half of the acceptance criteria. The assertions are on the English
 *    sentence, which is what makes a missing key a failure here rather than a `[log.empty]` on
 *    screen — `missingKeyHandler` throws under test, so a wrong key is loud either way.
 * 2. **A wait is announced politely, and not from a region of its own.** The whole point of
 *    routing it through the shared `<Announcer>` (GAP D1/G-54).
 * 3. **A failure renders the server's key, and takes focus.** Both halves matter: the key is what
 *    keeps prose out of the transport, and the focus move is the WCAG 3.3.1 answer that replaced a
 *    second live region.
 * 4. **axe is clean on all three.** Structurally, in jsdom — see `test/axe.ts` for what that
 *    covers and where the rest is covered.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Announcer, AnnouncerProvider } from "@/a11y";
import { ApiError, NO_RESPONSE } from "@/api";
import { expectAxeClean } from "@/test/axe";

import { EmptyState, ErrorState, LoadingState } from "./States";

/** The three states are leaves, so the shell around them is the Announcer and nothing else. */
function withAnnouncer(node: React.ReactNode): React.JSX.Element {
  return (
    <AnnouncerProvider>
      <Announcer stepMs={5} />
      {node}
    </AnnouncerProvider>
  );
}

describe("EmptyState", () => {
  it("renders its key's sentence from the catalogue", () => {
    render(<EmptyState messageKey="log.empty" />);
    expect(screen.getByText("Nothing yet. Roll the dice to start the story.")).toBeInTheDocument();
  });

  it("interpolates params, so a state can name what is missing", () => {
    render(<EmptyState messageKey="label.turn" params={{ number: 4 }} />);
    expect(screen.getByText("Turn 4")).toBeInTheDocument();
  });

  it("says nothing to a screen reader — an empty list is not news", async () => {
    // The counterpart to the loading test below, and the reason the two components differ. A log
    // that is empty at the start of a game is the normal state of a new game; announcing it would
    // spend the polite region on a non-event.
    render(withAnnouncer(<EmptyState messageKey="log.empty" />));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector('[data-announcer="polite"]')).toHaveTextContent("");
  });

  it("is axe clean", async () => {
    const { container } = render(<EmptyState messageKey="log.empty" />);
    await expectAxeClean(container);
  });
});

describe("LoadingState", () => {
  it("defaults to the catalogue's own loading sentence", () => {
    render(<LoadingState testId="wait" />);
    expect(screen.getByTestId("wait")).toHaveTextContent("Loading…");
  });

  it("announces the wait politely, through the one shared region", async () => {
    render(withAnnouncer(<LoadingState messageKey="save.loading" />));

    await waitFor(() => {
      expect(document.querySelector('[data-announcer="polite"]')).toHaveTextContent(
        "Opening the saved game…",
      );
    });
    // No region of its own. Two in the document, both the Announcer's (GAP D1/G-54).
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(2);
  });

  it("announces once per mount, however often its parent re-renders", async () => {
    // The defect this prevents: a pending query re-renders its subtree for unrelated reasons, and a
    // naive effect would queue "Loading…" once per render — so the polite region spends the whole
    // wait saying the same word instead of whatever comes next.
    const { rerender } = render(withAnnouncer(<LoadingState messageKey="save.loading" />));
    await waitFor(() => {
      expect(document.querySelector('[data-announcer="polite"]')).not.toHaveTextContent("");
    });

    rerender(withAnnouncer(<LoadingState messageKey="save.loading" />));
    rerender(withAnnouncer(<LoadingState messageKey="save.loading" />));

    // The bus serializes, holding each sentence for `stepMs` — so a second queued copy would still
    // be on screen after the first had been cleared. Waiting past the dwell and finding the region
    // empty is what proves only one was ever queued.
    await waitFor(() => {
      expect(document.querySelector('[data-announcer="polite"]')).toHaveTextContent("");
    });
  });

  it("stays silent when told to, for a wait that repeats", async () => {
    // `trade.checking` mounts once per keystroke while a draft is validated. Narrating each one is
    // the canonical way to make a screen reader unusable.
    render(withAnnouncer(<LoadingState messageKey="trade.checking" announce={false} />));

    expect(screen.getByText("Checking this offer…")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector('[data-announcer="polite"]')).toHaveTextContent("");
  });

  it("renders outside an AnnouncerProvider rather than throwing", () => {
    // `useOptionalAnnounce`'s whole reason to exist: every panel's three-state test renders a leaf
    // without the app shell, and a spinner that requires the shell is a spinner that cannot be
    // tested where it is used. `useAnnounce` still throws — asserted in `Announcer.test.tsx`.
    expect(() => render(<LoadingState />)).not.toThrow();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("is axe clean", async () => {
    // Without the Announcer: an axe run takes long enough that the bus's dwell timer fires during
    // it, outside `act`, and React's warning about that would be noise rather than a finding. What
    // is being checked here is the placeholder's own structure, which does not involve the bus.
    const { container } = render(<LoadingState announce={false} />);
    await expectAxeClean(container);
  });
});

describe("ErrorState", () => {
  it("renders the server's reason key with its params", () => {
    render(<ErrorState error={new ApiError(422, "error.server_at_capacity", { limit: 4 })} />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("The table is full — 4 games are already running.")).toBeInTheDocument();
  });

  it("falls back by HTTP class rather than throwing on a key the catalogue has not got", () => {
    // A newer server inventing a key must not blank the screen. Under test `missingKeyHandler`
    // throws, so the `i18n.exists` guard inside `useReasonText` is load-bearing, not defensive.
    const { unmount } = render(<ErrorState error={new ApiError(422, "error.invented_by_a_newer_server")} />);
    expect(screen.getByText("That move isn't allowed right now.")).toBeInTheDocument();
    unmount();

    render(<ErrorState error={new ApiError(503, "error.also_invented")} />);
    expect(screen.getByText("Network error. Please try again.")).toBeInTheDocument();
  });

  it("names a failure that never reached the server by its own key", () => {
    // `error.save_unreadable` is thrown client-side with `NO_RESPONSE` (MON-704). It must render as
    // itself, not collapse into the `error.network` fallback that a status of 0 would otherwise pick.
    render(<ErrorState error={new ApiError(NO_RESPONSE, "error.save_unreadable")} />);
    expect(screen.getByText("That file isn't a Kesef Street saved game.")).toBeInTheDocument();
  });

  it("takes focus instead of announcing itself", () => {
    // The WCAG 3.3.1 answer, and the reason this app has no `role="alert"`: urgency goes through the
    // Announcer's assertive channel, and a region here would say every refusal twice.
    render(withAnnouncer(<ErrorState error={new ApiError(422, "error.not_your_turn")} />));

    expect(document.activeElement?.textContent).toContain("It isn't your turn yet.");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("offers a retry only when one was given, and calls it", async () => {
    const retry = vi.fn();
    const { unmount } = render(
      <ErrorState error={new ApiError(500, "error.engine_failure")} onRetry={retry} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
    unmount();

    // Without one there is no button at all — a 422 refusing a seating arrangement will refuse it
    // again, and a button that changes nothing is worse than no button.
    render(<ErrorState error={new ApiError(422, "error.too_few_players", { minimum: 2, seats: 1 })} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("uses the heading it is given, so a rejected form says so", () => {
    render(
      <ErrorState
        error={new ApiError(422, "error.duplicate_names", { name: "Ruti" })}
        headingKey="setup.cannot_start"
      />,
    );
    expect(screen.getByText("Can't start yet")).toBeInTheDocument();
  });

  it("is axe clean, with and without the retry", async () => {
    const error = new ApiError(500, "error.engine_failure");
    const { container, unmount } = render(<ErrorState error={error} onRetry={() => undefined} />);
    await expectAxeClean(container);
    unmount();

    const bare = render(<ErrorState error={error} />);
    await expectAxeClean(bare.container);
  });
});
