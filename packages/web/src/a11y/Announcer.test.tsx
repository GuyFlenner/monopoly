import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Announcer, DEFAULT_STEP_MS } from "./Announcer";
import type { AnnouncementDraft } from "./announcements";
import { AnnouncerProvider, useAnnounce } from "./AnnouncerContext";

/**
 * Two claims, and both of them are the reason this item exists:
 *
 * 1. There are **two** live regions in the document, ever. Not three, not one per component.
 * 2. Two events in one command produce two announcements, **in order, in one region** — a
 *    region whose text is overwritten within a tick is announced once or not at all, which is
 *    how a rent payment silently disappears behind the roll that caused it.
 */

let push: (drafts: AnnouncementDraft | readonly AnnouncementDraft[]) => void;

function Pusher(): null {
  push = useAnnounce();
  return null;
}

function renderAnnouncer(): HTMLElement {
  const { container } = render(
    <AnnouncerProvider>
      <Announcer />
      <Pusher />
    </AnnouncerProvider>,
  );
  return container;
}

function region(container: HTMLElement, politeness: "polite" | "assertive"): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[aria-live="${politeness}"]`);
  if (found === null) {
    throw new Error(`no ${politeness} region`);
  }
  return found;
}

const polite = (key: string, params: Record<string, string | number> = {}): AnnouncementDraft => ({
  politeness: "polite",
  key,
  params,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Announcer", () => {
  it("owns exactly one polite and one assertive region, and nothing else", () => {
    const container = renderAnnouncer();

    expect(container.querySelectorAll("[aria-live]")).toHaveLength(2);
    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-live="assertive"]')).toHaveLength(1);
    // Atomic: a region read as a whole cannot be heard as a half-updated sentence.
    expect(region(container, "polite")).toHaveAttribute("aria-atomic", "true");
    expect(region(container, "assertive")).toHaveAttribute("aria-atomic", "true");
  });

  it("starts silent", () => {
    const container = renderAnnouncer();

    expect(region(container, "polite")).toHaveTextContent("");
    expect(region(container, "assertive")).toHaveTextContent("");
  });

  it("serializes two announcements from one push into one region, in order", () => {
    const container = renderAnnouncer();

    act(() => {
      push([
        polite("a11y.moved", { name: "Ruti", tile: "Boardwalk" }),
        polite("a11y.rent_charged", { payer: "Ruti", owner: "Dan", amount: 50 }),
      ]);
    });

    // The first sentence stands alone: the second has not overwritten it.
    expect(region(container, "polite")).toHaveTextContent("Ruti moved to Boardwalk.");
    expect(region(container, "polite")).not.toHaveTextContent("rent");

    act(() => {
      vi.advanceTimersByTime(DEFAULT_STEP_MS);
    });

    expect(region(container, "polite")).toHaveTextContent("Ruti paid 50 in rent to Dan.");
    // And it happened in *one* region. The assertive one never spoke.
    expect(region(container, "assertive")).toHaveTextContent("");
  });

  it("clears the region when the queue runs out, so a repeat is heard as a change", () => {
    const container = renderAnnouncer();

    act(() => {
      push(polite("a11y.turn", { name: "Ruti" }));
    });
    expect(region(container, "polite")).toHaveTextContent("It is Ruti's turn.");

    act(() => {
      vi.advanceTimersByTime(DEFAULT_STEP_MS);
    });

    expect(region(container, "polite")).toHaveTextContent("");
  });

  it("keeps the two regions independent — a turn change does not wait behind the dice", () => {
    const container = renderAnnouncer();

    act(() => {
      push([
        polite("a11y.diceResult", { first: 2, second: 5, total: 7 }),
        polite("a11y.moved", { name: "Ruti", tile: "Jail" }),
        { politeness: "assertive", key: "a11y.turn", params: { name: "Dan" } },
      ]);
    });

    // The dice are still being read out politely while the interrupt has already been said.
    expect(region(container, "polite")).toHaveTextContent("Rolled 2 and 5, total 7.");
    expect(region(container, "assertive")).toHaveTextContent("It is Dan's turn.");
  });

  it("keeps order across separate pushes rather than dropping what is still being said", () => {
    const container = renderAnnouncer();

    act(() => {
      push(polite("a11y.cash_paid", { name: "Ruti", amount: 50 }));
    });
    act(() => {
      push(polite("a11y.cash_gained", { name: "Dan", amount: 50 }));
    });

    expect(region(container, "polite")).toHaveTextContent("Ruti paid 50.");
    act(() => {
      vi.advanceTimersByTime(DEFAULT_STEP_MS);
    });
    expect(region(container, "polite")).toHaveTextContent("Dan received 50.");
  });

  it("respects a shorter step for a caller that wants one", () => {
    render(
      <AnnouncerProvider>
        <Announcer stepMs={10} />
        <Pusher />
      </AnnouncerProvider>,
    );

    act(() => {
      push([polite("a11y.passed_go", { name: "Ruti" }), polite("a11y.turn", { name: "Dan" })]);
    });
    act(() => {
      vi.advanceTimersByTime(10);
    });

    expect(screen.getByText("It is Dan's turn.")).toBeInTheDocument();
  });

  it("refuses to run outside a provider rather than swallowing announcements", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => {
      render(<Announcer />);
    }).toThrow(/AnnouncerProvider/);
  });
});
