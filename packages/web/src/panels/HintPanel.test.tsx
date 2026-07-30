import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Announcer, AnnouncerProvider } from "@/a11y";
import type { Command, RentQuote } from "@/api";

import { HintPanel, RentExplanation } from "./HintPanel";

/**
 * What must be true of the hint on screen.
 *
 * The two claims worth a test are the ones a screenshot cannot make. First, that the hint **cannot
 * send a command**: there is no button in this panel, deliberately, because a shortcut here would be
 * a route around MON-405's confirm dialog — so the assertion is about the *absence* of a control,
 * which is the kind of thing that gets helpfully added back by someone who has not read why.
 * Second, that it speaks through the one root `<Announcer>` and renders no region of its own.
 */

const player = 0;
const ROLL: Command = { kind: "roll_dice", player };
const END_TURN: Command = { kind: "end_turn", player, elapsed_seconds: null };
const BANKRUPTCY: Command = { kind: "declare_bankruptcy", player };

/** The panel with the one live `<Announcer>` above it, as the real app mounts it. */
function renderPanel(
  commands: readonly Command[],
  options: { prominent?: boolean; kids?: boolean } = {},
): HTMLElement {
  const { container } = render(
    <AnnouncerProvider>
      <Announcer />
      <HintPanel
        commands={commands}
        jailFine={50}
        prominent={options.prominent ?? true}
        kids={options.kids ?? false}
      />
    </AnnouncerProvider>,
  );
  return container;
}

function politeText(container: HTMLElement): string {
  return container.querySelector('[aria-live="polite"]')?.textContent ?? "";
}

describe("the hint names a move and says why", () => {
  it("shows the highest-ranked move and its reason", () => {
    renderPanel([END_TURN, ROLL]);
    expect(screen.getByTestId("hint-suggestion")).toHaveTextContent("Roll the dice");
    expect(screen.getByTestId("hint-reason")).toHaveTextContent(
      "Every turn starts with a roll. Nothing else can happen until the dice land.",
    );
  });

  it("carries the figure a label needs, so the bail hint is not silent about the amount", () => {
    renderPanel([{ kind: "pay_jail_fine", player }]);
    expect(screen.getByTestId("hint-suggestion")).toHaveTextContent("50");
  });

  it("says there is nothing to do rather than inventing a move", () => {
    renderPanel([]);
    expect(screen.getByTestId("hint-empty")).toHaveTextContent("Nothing to do right now.");
    expect(screen.queryByTestId("hint-suggestion")).not.toBeInTheDocument();
  });

  it("offers no button, so there is no path around the confirm step", () => {
    // A hint for a terminal command is the case that matters: `declare_bankruptcy` must reach the
    // engine only through the action bar's dialog.
    const container = renderPanel([BANKRUPTCY]);
    expect(screen.getByTestId("hint-reason")).toHaveTextContent("nothing left to sell");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("the hint speaks through the one live region", () => {
  it("renders no aria-live region of its own", () => {
    render(
      <AnnouncerProvider>
        <HintPanel commands={[ROLL]} jailFine={50} prominent kids={false} />
      </AnnouncerProvider>,
    );
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(0);
  });

  it("announces the move politely, in the same words it prints", () => {
    const container = renderPanel([ROLL]);
    // Politely, never assertively: a hint is not the acting player changing.
    expect(politeText(container)).toContain("Roll the dice");
    expect(container.querySelector('[aria-live="assertive"]')?.textContent).toBe("");
  });

  it("stays silent while the hint is folded away", () => {
    // Under the full rules the hint is a closed disclosure. Narrating what is not on screen is the
    // double-speak problem from the other direction.
    const container = renderPanel([ROLL], { prominent: false });
    expect(politeText(container)).toBe("");
  });
});

describe("prominence follows the rule set", () => {
  it("is a headed section when hints are prominent", () => {
    renderPanel([ROLL], { prominent: true });
    const panel = screen.getByTestId("hint-panel");
    expect(panel.dataset.prominent).toBe("true");
    expect(screen.getByRole("heading", { name: "What now?" })).toBeInTheDocument();
  });

  it("is a closed disclosure otherwise, and a native one", async () => {
    renderPanel([ROLL], { prominent: false });
    const panel = screen.getByTestId("hint-panel");
    expect(panel.dataset.prominent).toBe("false");
    expect(panel).not.toHaveAttribute("open");

    // `<details>`/`<summary>`, so keyboard operation, the expandable-group role and find-in-page all
    // come from the browser rather than from a keydown handler this file would have to get right.
    // (jsdom does not put `<summary>` in its focusable set, so the *focus* half of that claim cannot
    // be asserted here — it is the element choice that carries it, which is why the tag is checked.)
    const summary = screen.getByText("Show a hint");
    expect(summary.tagName).toBe("SUMMARY");
    expect(panel.tagName).toBe("DETAILS");

    await userEvent.click(summary);
    expect(panel).toHaveAttribute("open");
  });

  it("prefers the simpler wording in a kids game", () => {
    renderPanel([ROLL], { kids: true });
    expect(screen.getByTestId("hint-suggestion")).toHaveTextContent("Throw the dice");
  });
});

const QUOTE: RentQuote = {
  owner: 1,
  tile: 12,
  amount: 40,
  base_rent: 10,
  houses: 2,
  multiplier: 4,
  dice_total: 10,
  group: null,
  note_keys: [],
  note_params: {},
};

describe("RentExplanation — the figures, never the sum", () => {
  function renderQuote(quote: RentQuote, open = true): void {
    render(<RentExplanation quote={quote} t={(key) => key} open={open} />);
  }

  it("prints each field of the quote beside its own label", () => {
    // An identity `t`, so the assertion is about which *keys* are reached rather than about English.
    renderQuote(QUOTE);
    const panel = screen.getByTestId("rent-explanation");
    expect(panel.textContent).toContain("hint.rent.base");
    expect(panel.textContent).toContain("10");
    expect(panel.textContent).toContain("hint.rent.houses");
    expect(panel.textContent).toContain("hint.rent.multiplier");
    expect(panel.textContent).toContain("hint.rent.dice_total");
  });

  it("never prints a product of two of them", () => {
    // 10 × 4 = 40 is `amount`, which the panel above this one already shows from the projection.
    // A "40" appearing *here* would mean this component had done the sum — the one thing it must not.
    renderQuote(QUOTE);
    const rows = screen.getByTestId("rent-explanation").querySelectorAll("dd");
    expect([...rows].map((row) => row.textContent)).toEqual(["10", "2", "4", "10"]);
  });

  it("omits a multiplier of one and an unused dice total", () => {
    renderQuote({
      ...QUOTE,
      amount: 10,
      houses: 0,
      multiplier: 1,
      dice_total: null,
    });
    const rows = screen.getByTestId("rent-explanation").querySelectorAll("dd");
    expect([...rows].map((row) => row.textContent)).toEqual(["10"]);
  });

  it("starts open where a kids game asks for it", () => {
    renderQuote(QUOTE, true);
    expect(screen.getByTestId("rent-explanation")).toHaveAttribute("open");
  });

  it("stays on demand under the full rules", () => {
    renderQuote(QUOTE, false);
    expect(screen.getByTestId("rent-explanation")).not.toHaveAttribute("open");
  });
});
