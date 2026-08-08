/**
 * What these tests are for, in order of how expensive the defect would be.
 *
 * 1. **The projected arrays win over anything derivable from them.** The falsifier: a frame whose
 *    `withdrawn` *disagrees* with `eligible − active`. An implementation that subtracts the two
 *    passes every ordinary fixture and fails these two, which is the whole reason they are here —
 *    the M3 review established that a test which cannot distinguish "projected" from "derived"
 *    documents the intent without defending it.
 * 2. **A bid above `max_bid` cannot be submitted, and the ceiling is never invented.** Including
 *    the case that matters: `max_bid` above the bidder's cash. A panel that quietly limited to
 *    cash would have copied a rule into TypeScript (G-7b), and this asserts it did not.
 * 3. **The ≥90%-of-cash confirm fires, and withdrawal confirms.** Both are one press away from
 *    being irreversible for a six-year-old (GAP C4).
 * 4. **The focus contract**: trapped, restored, Escape announced when it cannot close.
 * 5. **No `aria-live` anywhere** — MON-411 owns the regions (GAP D1/G-54).
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { AnnouncerProvider, useAnnouncer, type AnnouncementDraft } from "@/a11y";
import type { BoardView, Command, PlayerView } from "@/api";
import { i18n } from "@/i18n";

import { makeBoard, makePlayer, makeTile } from "../test/fixtures";
import { AuctionPanel, type AuctionFrameView } from "./AuctionPanel";

const PLAYERS: readonly PlayerView[] = [
  makePlayer(0, { name: "Ruti", cash: 100 }),
  makePlayer(1, { name: "Dan", cash: 100 }),
  makePlayer(2, { name: "Noa", cash: 100 }),
];

const BOARD: BoardView = makeBoard({
  tiles: [
    makeTile(0, { kind: "go", group: null, is_ownable: false }),
    makeTile(1, { name_key: "tile.classic.mediterranean_avenue" }),
  ],
});

const BID: Command = { kind: "place_bid", player: 0, amount: 1 };
const WITHDRAW: Command = { kind: "withdraw_from_auction", player: 0 };

function makeFrame(overrides: Partial<AuctionFrameView> = {}): AuctionFrameView {
  return {
    kind: "auction",
    resume: "awaiting_roll",
    lot: { kind: "tile", tile: 1 },
    reason: "declined_purchase",
    eligible: [0, 1, 2],
    active: [0, 1, 2],
    turn: 0,
    high_bid: 0,
    high_bidder: null,
    min_bid: 1,
    max_bid: 100,
    queue: [],
    withdrawn: [],
    ...overrides,
  };
}

interface Harness {
  readonly sent: Command[];
  readonly said: AnnouncementDraft[];
}

function renderPanel(
  frame: AuctionFrameView,
  options: {
    readonly legalCommands?: readonly Command[];
    readonly players?: readonly PlayerView[];
    readonly onClose?: () => void;
  } = {},
): Harness {
  const sent: Command[] = [];
  const said: AnnouncementDraft[] = [];
  function Spy(): React.JSX.Element {
    return (
      <AuctionPanel
        frame={frame}
        players={options.players ?? PLAYERS}
        board={BOARD}
        legalCommands={options.legalCommands ?? [BID, WITHDRAW]}
        onSend={(command) => sent.push(command)}
        {...(options.onClose !== undefined ? { onClose: options.onClose } : {})}
      />
    );
  }
  render(
    <AnnouncerProvider>
      <Recorder onDraft={(draft) => said.push(draft)} />
      <Spy />
    </AnnouncerProvider>,
  );
  return { sent, said };
}

/**
 * Taps the announcement bus, so a test can assert what was *said*.
 *
 * The panel has no live region to read, by design, which means the only honest way to test its
 * narration is to subscribe where it actually speaks.
 */
function Recorder({ onDraft }: { readonly onDraft: (draft: AnnouncementDraft) => void }): null {
  const { bus } = useAnnouncer();
  useEffect(
    () =>
      bus.subscribe((added) => {
        for (const announcement of added) {
          onDraft(announcement);
        }
      }),
    [bus, onDraft],
  );
  return null;
}

/**
 * Type an amount into the numeric box as one edit.
 *
 * `clear()` then `type()` would fire a change per keystroke, and an intermediate "" is not an
 * amount — the panel resets to the projected minimum for it, so the keystrokes land on top of a
 * value the test did not choose. One change event is what a player pasting or spinning the box
 * produces, and it is the entry this panel actually has to police.
 */
function enterAmount(value: string): void {
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value } });
}

afterEach(async () => {
  // The suite runs in English (`src/test/setup.ts`). The Hebrew case below changes that and has to
  // hand it back, the way `CardReveal.test.tsx` does.
  if (i18n.language !== "en") {
    await act(async () => {
      await i18n.changeLanguage("en");
    });
  }
});

/** The bidder's row on the rail, found by the projected player id rather than by position. */
function bidderRow(id: number): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-bidder="${String(id)}"]`);
  if (row === null) {
    throw new Error(`no rail entry for player ${String(id)}`);
  }
  return row;
}

describe("the projected auction state is rendered, never a derived one", () => {
  it("shows the withdrawal `withdrawn` reports even though `eligible - active` reports none", async () => {
    // The falsifier. `eligible - active` is empty, so an implementation that subtracts the two
    // arrays would say nobody has dropped out. `withdrawn` says Noa has.
    renderPanel(makeFrame({ eligible: [0, 1, 2], active: [0, 1, 2], withdrawn: [2] }));

    expect(within(bidderRow(2)).getByText("Dropped out")).toBeInTheDocument();
    expect(within(bidderRow(1)).queryByText("Dropped out")).not.toBeInTheDocument();
    expect(await screen.findByText("Noa")).toBeInTheDocument();
  });

  it("shows nobody withdrawn when `withdrawn` is empty but `active` omits a bidder", () => {
    // The other direction. `eligible - active` is `[2]`, so a subtracting implementation would
    // mark Noa as out. The projection says nobody has withdrawn.
    renderPanel(makeFrame({ eligible: [0, 1, 2], active: [0, 1], withdrawn: [] }));

    expect(screen.queryByText("Dropped out")).not.toBeInTheDocument();
    expect(within(bidderRow(1)).getByText("Still in")).toBeInTheDocument();
  });

  it("takes the high bid and bidder from the projection", () => {
    renderPanel(makeFrame({ high_bid: 45, high_bidder: 1, min_bid: 46 }));

    expect(screen.getByText("Dan holds the bid at $45.")).toBeInTheDocument();
    // The ribbon says which money it is too (MON-744) — it used to read a bare "45" directly under
    // the sentence above, which is the same figure written two ways.
    expect(within(bidderRow(1)).getByText("$45")).toBeInTheDocument();
  });

  it("names the acting bidder from `turn` and marks that row", () => {
    renderPanel(makeFrame({ turn: 2 }));

    expect(screen.getByRole("heading", { name: "Noa, it's your turn to bid" })).toBeInTheDocument();
    expect(within(bidderRow(2)).getByText("Bidding now")).toBeInTheDocument();
    expect(within(bidderRow(0)).getByText("Still in")).toBeInTheDocument();
  });

  it("gives the acting seat a shape and an icon, not only a colour", () => {
    renderPanel(makeFrame({ turn: 1 }));

    // `<Token>` draws the seat's shape and rider; the assertion is that the row has an SVG at all,
    // so a regression to a bare coloured dot fails here.
    expect(bidderRow(1).querySelector("svg")).not.toBeNull();
  });
});

describe("the bid ceiling comes off the projection", () => {
  it("refuses to submit above `max_bid`", () => {
    const { sent } = renderPanel(makeFrame({ min_bid: 1, max_bid: 12 }));

    enterAmount("13");

    expect(screen.getByText("The most you can bid is $12.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bid \$13/ })).toBeDisabled();
    expect(sent).toEqual([]);
  });

  it("allows a bid above the bidder's cash when `max_bid` allows it", async () => {
    const user = userEvent.setup();
    // Cash 100, ceiling 500. A panel that limited to cash would have invented the rule G-7b
    // exists to keep out of TypeScript.
    const { sent } = renderPanel(makeFrame({ min_bid: 1, max_bid: 500 }), {
      players: [makePlayer(0, { name: "Ruti", cash: 100 }), makePlayer(1, { name: "Dan" })],
    });

    enterAmount("300");
    await user.click(screen.getByRole("button", { name: /Bid \$300/ }));
    // Above 90% of cash, so it confirms rather than sending outright.
    await user.click(screen.getByRole("button", { name: /Bid \$300/ }));

    expect(sent).toEqual([{ kind: "place_bid", player: 0, amount: 300 }]);
  });

  it("clamps the increment buttons to `max_bid` rather than to anything it worked out", async () => {
    const user = userEvent.setup();
    renderPanel(makeFrame({ min_bid: 1, max_bid: 20 }));

    await user.click(screen.getByRole("button", { name: "$50" }));

    expect(screen.getByRole("button", { name: /Bid \$20/ })).toBeEnabled();
  });

  it("refuses to submit below `min_bid`", () => {
    const { sent } = renderPanel(makeFrame({ min_bid: 25, max_bid: 100 }));

    enterAmount("5");

    expect(screen.getByText("That is under the lowest bid of $25.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bid \$5/ })).toBeDisabled();
    expect(sent).toEqual([]);
  });

  it("starts at the projected minimum", () => {
    renderPanel(makeFrame({ min_bid: 33 }));

    expect(screen.getByRole("spinbutton")).toHaveValue(33);
  });

  it("has no ceiling message when the projection ships none", () => {
    renderPanel(makeFrame({ max_bid: null }));

    expect(screen.queryByText(/Highest you can bid/)).not.toBeInTheDocument();
  });
});

/**
 * MON-744: the figures this panel *draws* say which money they are, like the ones it *says*.
 *
 * The sentences were never the problem — `auction.floor` and friends interpolate
 * `{{amount, money}}` and have since MON-720. The three drawn figures did not, so the panel read
 * "Lowest you can bid: $10" directly above an unlabelled "10" and a row of buttons offering "10".
 *
 * The Hebrew case is what makes this a formatter test rather than a string test: the same
 * component, the same frame, a different language, and the symbol moves to the other side of the
 * digits. An implementation that hardcoded a `$` passes the English half and fails here.
 */
describe("the drawn figures carry the currency, in both languages", () => {
  /**
   * The space `money.ts` puts between a Hebrew figure and its sign: **non-breaking**.
   *
   * Written as an escape here for the reason that file gives for writing it as one — a code point
   * nobody can see in a diff is a code point nobody can review.
   */
  const NBSP = "\u00a0";

  it("labels the standing figure, the increments and the ribbon in English", () => {
    renderPanel(makeFrame({ min_bid: 10, high_bid: 45, high_bidder: 1 }));

    expect(screen.getByTestId("auction-current-bid")).toHaveTextContent("$10");
    expect(screen.getByRole("button", { name: "$1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "$10" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "$50" })).toBeInTheDocument();
    expect(within(bidderRow(1)).getByText("$45")).toBeInTheDocument();
  });

  it("puts the shekel sign after the figure in Hebrew, with no change to this component", async () => {
    await act(async () => {
      await i18n.changeLanguage("he");
    });
    renderPanel(makeFrame({ min_bid: 10, high_bid: 45, high_bidder: 1 }));

    // `textContent` rather than a text matcher, so the non-breaking space is asserted as itself:
    // Testing Library's normaliser collapses it to a plain space, which is exactly the layout
    // guarantee `money.ts` makes and therefore the one a text matcher cannot see.
    const figure = screen.getByTestId("auction-current-bid").textContent;
    expect(figure).toBe(`10${NBSP}₪`);
    // Not the English rendering — the falsifier for a symbol hardcoded into the component.
    expect(figure).not.toBe("$10");
    // The ribbon, through a matcher, where the collapsed space is what the matcher sees.
    expect(within(bidderRow(1)).getByText("45 ₪")).toBeInTheDocument();
  });
});

describe("the expensive taps take two presses", () => {
  it("sends a modest bid straight away", async () => {
    const user = userEvent.setup();
    const { sent } = renderPanel(makeFrame({ min_bid: 10 }));

    await user.click(screen.getByRole("button", { name: /Bid \$10/ }));

    expect(sent).toEqual([{ kind: "place_bid", player: 0, amount: 10 }]);
  });

  it("confirms a bid worth 90% or more of the bidder's cash", async () => {
    const user = userEvent.setup();
    const { sent } = renderPanel(makeFrame({ min_bid: 90, max_bid: 100 }));

    await user.click(screen.getByRole("button", { name: /Bid \$90/ }));

    expect(sent).toEqual([]);
    expect(
      screen.getByText("Bidding $90 spends nearly everything you have. Bid it anyway?"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Bid \$90/ }));
    expect(sent).toEqual([{ kind: "place_bid", player: 0, amount: 90 }]);
  });

  it("lets the player back out of the confirm without bidding", async () => {
    const user = userEvent.setup();
    const { sent } = renderPanel(makeFrame({ min_bid: 95, max_bid: 100 }));

    await user.click(screen.getByRole("button", { name: /Bid \$95/ }));
    await user.click(screen.getByRole("button", { name: "No, go back" }));

    expect(sent).toEqual([]);
  });

  it("warns past half the bidder's cash without demanding a confirm", async () => {
    const user = userEvent.setup();
    const { sent } = renderPanel(makeFrame({ min_bid: 60, max_bid: 100 }));

    expect(screen.getByText("That is more than half of your money.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Bid \$60/ }));
    expect(sent).toEqual([{ kind: "place_bid", player: 0, amount: 60 }]);
  });

  it("confirms a withdrawal, because withdrawing is terminal", async () => {
    const user = userEvent.setup();
    const { sent } = renderPanel(makeFrame());

    await user.click(screen.getByRole("button", { name: /Drop out/ }));

    expect(sent).toEqual([]);
    expect(screen.getByText(/Dropping out is final/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Drop out/ }));
    expect(sent).toEqual([{ kind: "withdraw_from_auction", player: 0 }]);
  });
});

describe("only what the engine offered is offered", () => {
  it("omits the withdraw control when the engine did not offer it", () => {
    renderPanel(makeFrame(), { legalCommands: [BID] });

    expect(screen.queryByRole("button", { name: /Drop out/ })).not.toBeInTheDocument();
  });

  it("disables bidding when the engine did not offer it", () => {
    renderPanel(makeFrame(), { legalCommands: [WITHDRAW] });

    expect(screen.getByRole("button", { name: /Bid/ })).toBeDisabled();
  });
});

describe("the modal focus contract", () => {
  it("is a labelled modal dialog", () => {
    renderPanel(makeFrame());

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Auction");
  });

  it("moves focus into the panel on open", () => {
    renderPanel(makeFrame());

    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("keeps Tab inside the panel", async () => {
    const user = userEvent.setup();
    renderPanel(makeFrame());
    const dialog = screen.getByRole("dialog");

    // Enough tabs to leave any panel that was not trapping.
    for (let index = 0; index < 12; index += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("restores focus to whatever opened it", async () => {
    const user = userEvent.setup();
    function Host(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <AnnouncerProvider>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            open
          </button>
          {open && (
            <AuctionPanel
              frame={makeFrame()}
              players={PLAYERS}
              board={BOARD}
              legalCommands={[BID, WITHDRAW]}
              onSend={() => undefined}
              onClose={() => {
                setOpen(false);
              }}
            />
          )}
        </AnnouncerProvider>
      );
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "open" });
    await user.click(opener);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  it("announces why it cannot close when the phase forbids leaving", async () => {
    const user = userEvent.setup();
    const { said } = renderPanel(makeFrame());

    await user.keyboard("{Escape}");

    expect(said.map(({ politeness, key, params }) => ({ politeness, key, params }))).toEqual([
      { politeness: "polite", key: "auction.cannot_leave", params: {} },
    ]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("says the same thing visibly, not only to a screen reader", () => {
    renderPanel(makeFrame());

    expect(screen.getByText(/The auction has to finish/)).toBeInTheDocument();
  });

  it("offers no close button when there is nowhere to go", () => {
    renderPanel(makeFrame());

    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });
});

describe("narration and interaction floors", () => {
  it("mounts no live region of its own", () => {
    renderPanel(makeFrame());
    const dialog = screen.getByRole("dialog");

    expect(dialog.querySelectorAll("[aria-live]")).toHaveLength(0);
    // `status`, `alert` and `log` carry an implicit live region, so they are the same defect.
    expect(dialog.querySelectorAll('[role="status"], [role="alert"], [role="log"]')).toHaveLength(
      0,
    );
  });

  it("has no drag handler anywhere (GAP C2)", () => {
    renderPanel(makeFrame());
    const dialog = screen.getByRole("dialog");

    for (const attribute of ["draggable", "ondragstart", "ondrop", "ondragover"]) {
      expect(dialog.querySelectorAll(`[${attribute}]`)).toHaveLength(0);
    }
  });

  it("uses no physical CSS property in its class names", () => {
    renderPanel(makeFrame());

    const physical =
      /\b-?(?:ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|text-left|text-right|space-x|translate-x)-/;
    for (const element of screen.getByRole("dialog").querySelectorAll("*")) {
      expect(element.getAttribute("class") ?? "").not.toMatch(physical);
    }
  });
});

describe("the lot is named from the board, not from the frame", () => {
  it("resolves a tile lot through the board's own namespace", () => {
    renderPanel(makeFrame({ lot: { kind: "tile", tile: 1 } }));

    expect(screen.getByText(/Mediterranean Avenue/)).toBeInTheDocument();
  });

  it("names a building lot from the catalogue", () => {
    renderPanel(makeFrame({ lot: { kind: "building", building: "hotel" } }));

    expect(screen.getByText(/Up for auction: hotel/)).toBeInTheDocument();
  });

  it("renders the reason the auction is happening", () => {
    renderPanel(makeFrame({ reason: "building_shortage" }));

    expect(screen.getByText(/the bank is short of buildings/)).toBeInTheDocument();
  });
});

/** Nobody is bidding: the panel still renders rather than crashing on a null `turn`. */
describe("a frame with no bidder", () => {
  it("renders and offers nothing to press", () => {
    renderPanel(makeFrame({ turn: null }));

    expect(
      screen.getByRole("heading", { name: "Nobody is bidding right now" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bid/ })).toBeDisabled();
  });
});
