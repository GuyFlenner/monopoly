/**
 * What these tests are for, in order of how expensive the defect would be.
 *
 * 1. **Legality comes from `validate`, not from the panel.** Two falsifiers, one each way. A draft
 *    that offers more cash than the player holds is *sendable* when the stub validator allows it —
 *    so a panel that had quietly capped the box, or greyed the button out on its own arithmetic,
 *    fails. And a draft that looks perfectly ordinary is *refused* when the stub says so, with the
 *    engine's own `reason_key` on screen. Between them, the only implementation that passes is one
 *    that asks and renders the answer (G-32).
 * 2. **`simplified_trades` is not enforced here.** Two items per side, Kids mode on, validator
 *    happy — sendable. The one-item limit is the engine's, and this asserts the UI did not grow a
 *    second copy of it.
 * 3. **An empty draft cannot be sent** (the MON-410 amendment), and the button is *absent* rather
 *    than disabled, because there is nothing to explain.
 * 4. **No drag, no `aria-live`, focus trapped and restored** — the same floors as the auction.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";

import { AnnouncerProvider, useAnnouncer, type AnnouncementDraft } from "@/a11y";
import type { BoardView, Command, LegalityView, PlayerView } from "@/api";

import { makeBoard, makePlayer, makeTile } from "../test/fixtures";
import { TradeBuilder } from "./TradeBuilder";

// Positional: `board.tiles[i]` is the square at index `i`, which is how the wire ships it and how
// every consumer looks a name up. A sparse array here would name the wrong streets.
const BOARD: BoardView = makeBoard({
  tiles: [
    makeTile(0, { kind: "go", group: null, is_ownable: false }),
    makeTile(1, { name_key: "tile.classic.mediterranean_avenue" }),
    makeTile(2, { name_key: "tile.classic.community_chest_1", is_ownable: false }),
    makeTile(3, { name_key: "tile.classic.baltic_avenue" }),
    makeTile(4, { name_key: "tile.classic.income_tax", is_ownable: false }),
    makeTile(5, { name_key: "tile.classic.reading_railroad" }),
    makeTile(6, { name_key: "tile.classic.oriental_avenue" }),
  ],
});

const PLAYERS: readonly PlayerView[] = [
  makePlayer(0, { name: "Ruti", cash: 50, tiles_owned: [1, 3], jail_cards: ["chance"] }),
  makePlayer(1, { name: "Dan", cash: 500, tiles_owned: [6], jail_cards: [] }),
];

const LEGAL: LegalityView = { legal: true, reason_key: null, params: {} };

interface Harness {
  readonly sent: Command[];
  readonly asked: Command[];
  readonly said: AnnouncementDraft[];
}

function renderBuilder(
  options: {
    readonly answer?: LegalityView | ((command: Command) => LegalityView);
    readonly players?: readonly PlayerView[];
    readonly simplifiedTrades?: boolean;
    readonly renderDossier?: (playerId: number) => React.ReactNode;
    readonly onClose?: () => void;
  } = {},
): Harness {
  const sent: Command[] = [];
  const asked: Command[] = [];
  const said: AnnouncementDraft[] = [];
  const answer = options.answer ?? LEGAL;
  render(
    <AnnouncerProvider>
      <Recorder
        onDraft={(draft) => {
          said.push(draft);
        }}
      />
      <TradeBuilder
        proposer={0}
        players={options.players ?? PLAYERS}
        board={BOARD}
        simplifiedTrades={options.simplifiedTrades ?? false}
        validate={(command) => {
          asked.push(command);
          return Promise.resolve(typeof answer === "function" ? answer(command) : answer);
        }}
        onSend={(command) => {
          sent.push(command);
        }}
        {...(options.renderDossier !== undefined ? { renderDossier: options.renderDossier } : {})}
        {...(options.onClose !== undefined ? { onClose: options.onClose } : {})}
      />
    </AnnouncerProvider>,
  );
  return { sent, asked, said };
}

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

/** One side's tray, found by whose things are in it. */
function tray(name: string): HTMLElement {
  return screen.getByRole("region", { name: `${name} gives` });
}

function sendButton(): HTMLElement {
  return screen.getByRole("button", { name: "Send this offer" });
}

describe("legality is the validator's answer, never the panel's opinion", () => {
  it("posts the draft to `validate` as a `propose_trade` command", async () => {
    const user = userEvent.setup();
    const { asked } = renderBuilder();

    await user.click(within(tray("Ruti")).getByRole("checkbox", { name: /Mediterranean/ }));

    await waitFor(() => {
      expect(asked).toHaveLength(1);
    });
    expect(asked[0]).toEqual({
      kind: "propose_trade",
      player: 0,
      offer: {
        proposer: 0,
        recipient: 1,
        give: { cash: 0, tiles: [1], jail_cards: [] },
        receive: { cash: 0, tiles: [], jail_cards: [] },
      },
    });
  });

  it("sends a draft the validator allows even though it offers more cash than the player holds", async () => {
    const user = userEvent.setup();
    // Ruti holds 50. The draft offers 100. A panel that capped the box at what she holds, or that
    // decided solvency for itself, could not reach this assertion.
    const { sent } = renderBuilder({ answer: LEGAL });

    const box = within(tray("Ruti")).getByRole("spinbutton", { name: "Cash from Ruti" });
    await user.clear(box);
    await user.type(box, "100");

    await waitFor(() => {
      expect(sendButton()).toBeEnabled();
    });
    await user.click(sendButton());

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      offer: { give: { cash: 100 } },
    });
  });

  it("refuses a draft the validator rejects, and says how much short", async () => {
    const user = userEvent.setup();
    const { sent } = renderBuilder({
      answer: {
        legal: false,
        reason_key: "error.insufficient_funds",
        // The params the engine has always sent and the sentence never spent until MON-723. Asserted
        // with their figures in, because "Not enough cash for that." passed for both.
        params: { required: 100, available: 40 },
      },
    });

    await user.click(within(tray("Ruti")).getByRole("checkbox", { name: /Mediterranean/ }));

    await waitFor(() => {
      expect(
        screen.getByText("Not enough cash — that costs $100 and you have $40."),
      ).toBeInTheDocument();
    });
    expect(sendButton()).toBeDisabled();
    expect(sent).toEqual([]);
  });

  it("resolves a *_key param through the catalogue rather than printing the engine's enum", async () => {
    const user = userEvent.setup();
    renderBuilder({
      answer: {
        legal: false,
        reason_key: "error.group_has_buildings",
        // MON-415's convention on a refusal (MON-723). `_trade_side` is the engine path that emits
        // this, and it now sends the *key*: printing `light_blue` here would be the engine's English
        // identifier inside a sentence, which is the whole reason `_key` exists.
        params: { group_key: "group.light_blue" },
      },
    });

    await user.click(within(tray("Ruti")).getByRole("checkbox", { name: /Mediterranean/ }));

    await waitFor(() => {
      expect(
        screen.getByText("Sell the houses on the Light blue set before mortgaging."),
      ).toBeInTheDocument();
    });
  });

  it("interpolates the params the engine sent with the reason", async () => {
    const user = userEvent.setup();
    renderBuilder({
      answer: { legal: false, reason_key: "error.unknown_board", params: { board_id: "atlantis" } },
    });

    await user.click(within(tray("Ruti")).getByRole("checkbox", { name: /Mediterranean/ }));

    await waitFor(() => {
      expect(screen.getByText("There's no board called atlantis.")).toBeInTheDocument();
    });
  });

  it("keeps the send shut while there is no answer yet", async () => {
    renderBuilder({ answer: LEGAL });

    // `fireEvent` rather than `userEvent` (MON-731): the same reason the burst test below gives —
    // `userEvent`'s click awaits, and under coverage instrumentation that await was occasionally
    // slow enough on its own to cross the 150 ms debounce, so this assertion raced the panel's own
    // timer instead of testing it. `fireEvent` commits synchronously, so the "before" snapshot below
    // is taken before any timer could possibly have fired, at any instrumentation speed.
    fireEvent.click(within(tray("Ruti")).getByRole("checkbox", { name: /Mediterranean/ }));

    // Before the debounce and the promise resolve, the panel has no verdict and says so.
    expect(screen.getByText("Checking this offer…")).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();

    await waitFor(() => {
      expect(sendButton()).toBeEnabled();
    });
  });

  it("does not treat a failed validate call as a refusal", async () => {
    const user = userEvent.setup();
    const sent: Command[] = [];
    render(
      <AnnouncerProvider>
        <TradeBuilder
          proposer={0}
          players={PLAYERS}
          board={BOARD}
          validate={() => Promise.reject(new Error("offline"))}
          onSend={(command) => {
            sent.push(command);
          }}
        />
      </AnnouncerProvider>,
    );

    await user.click(within(tray("Ruti")).getByRole("checkbox", { name: /Mediterranean/ }));

    await waitFor(() => {
      expect(sendButton()).toBeDisabled();
    });
    // No invented verdict: a transport failure is not the engine saying no.
    expect(screen.queryByText("This offer cannot be sent.")).not.toBeInTheDocument();
    expect(sent).toEqual([]);
  });
});

describe("simplified_trades is rendered, not enforced", () => {
  it("explains the limit in Kids mode", () => {
    renderBuilder({ simplifiedTrades: true });

    expect(screen.getByText("Kids mode: one thing from each side per trade.")).toBeInTheDocument();
  });

  it("still lets the validator be the one to reject a two-item side", async () => {
    const user = userEvent.setup();
    const { sent } = renderBuilder({ simplifiedTrades: true, answer: LEGAL });

    const ruti = within(tray("Ruti"));
    await user.click(ruti.getByRole("checkbox", { name: /Mediterranean/ }));
    await user.click(ruti.getByRole("checkbox", { name: /Baltic/ }));

    await waitFor(() => {
      expect(sendButton()).toBeEnabled();
    });
    await user.click(sendButton());

    // Two tiles went out. If the panel had enforced the one-item rule it would have blocked this,
    // which is the defect: two implementations of one rule, drifting.
    expect(sent[0]).toMatchObject({ offer: { give: { tiles: [1, 3] } } });
  });

  it("says nothing about the limit under the full rules", () => {
    renderBuilder({ simplifiedTrades: false });

    expect(screen.queryByText(/Kids mode/)).not.toBeInTheDocument();
  });
});

describe("an empty draft is not an offer", () => {
  it("hides the send button until something is on the table", async () => {
    const user = userEvent.setup();
    const { asked } = renderBuilder();

    expect(screen.queryByRole("button", { name: "Send this offer" })).not.toBeInTheDocument();
    expect(screen.getByText("Put something on the table to make an offer.")).toBeInTheDocument();
    // Nothing to ask about either — an empty draft is not a question for the server.
    expect(asked).toEqual([]);

    await user.click(within(tray("Ruti")).getByRole("checkbox", { name: /Mediterranean/ }));

    expect(screen.getByRole("button", { name: "Send this offer" })).toBeInTheDocument();
  });

  it("hides it again when the last item comes back off", async () => {
    const user = userEvent.setup();
    renderBuilder();
    const box = within(tray("Ruti")).getByRole("spinbutton", { name: "Cash from Ruti" });

    await user.click(within(tray("Ruti")).getByRole("button", { name: "Add $10" }));
    expect(screen.getByRole("button", { name: "Send this offer" })).toBeInTheDocument();

    await user.click(within(tray("Ruti")).getByRole("button", { name: "Take off $10" }));

    expect(box).toHaveValue(0);
    expect(screen.queryByRole("button", { name: "Send this offer" })).not.toBeInTheDocument();
  });

  it("counts either side, not only the proposer's", async () => {
    const user = userEvent.setup();
    renderBuilder();

    await user.click(within(tray("Dan")).getByRole("checkbox", { name: /Oriental/ }));

    expect(screen.getByRole("button", { name: "Send this offer" })).toBeInTheDocument();
  });
});

describe("both sides of the table", () => {
  it("lists each player's own holdings and nobody else's", () => {
    renderBuilder();

    expect(
      within(tray("Ruti")).getByRole("checkbox", { name: /Mediterranean/ }),
    ).toBeInTheDocument();
    expect(
      within(tray("Ruti")).queryByRole("checkbox", { name: /Oriental/ }),
    ).not.toBeInTheDocument();
    expect(within(tray("Dan")).getByRole("checkbox", { name: /Oriental/ })).toBeInTheDocument();
  });

  it("offers a jail card only where one is held", () => {
    renderBuilder();

    expect(within(tray("Ruti")).getByRole("checkbox", { name: /Chance/ })).toBeInTheDocument();
    expect(within(tray("Dan")).getByText("No cards to offer")).toBeInTheDocument();
  });

  it("renders the injected dossier for both sides", () => {
    renderBuilder({
      renderDossier: (playerId) => <p>dossier for {playerId}</p>,
    });

    expect(within(tray("Ruti")).getByText("dossier for 0")).toBeInTheDocument();
    expect(within(tray("Dan")).getByText("dossier for 1")).toBeInTheDocument();
  });

  it("draws no dossier of its own when the slot is empty", () => {
    renderBuilder();

    expect(screen.queryByText(/dossier/i)).not.toBeInTheDocument();
  });

  it("clears the other side when the recipient changes", async () => {
    const user = userEvent.setup();
    const players = [
      ...PLAYERS,
      makePlayer(2, { name: "Noa", cash: 200, tiles_owned: [], jail_cards: [] }),
    ];
    renderBuilder({ players });

    await user.click(within(tray("Dan")).getByRole("checkbox", { name: /Oriental/ }));
    await user.click(screen.getByRole("radio", { name: /Noa/ }));

    // Dan's property cannot ride along into an offer Noa is answering.
    expect(screen.queryByRole("checkbox", { name: /Oriental/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send this offer" })).not.toBeInTheDocument();
  });

  it("offers no bankrupt player as a partner", () => {
    const players = [...PLAYERS, makePlayer(2, { name: "Noa", bankrupt: true, tiles_owned: [] })];
    renderBuilder({ players });

    expect(screen.queryByRole("radio", { name: /Noa/ })).not.toBeInTheDocument();
  });
});

describe("the modal focus contract", () => {
  it("is a labelled modal dialog", () => {
    renderBuilder();

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Offer a trade");
  });

  it("moves focus into the panel on open", () => {
    renderBuilder();

    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("keeps Tab inside the panel", async () => {
    const user = userEvent.setup();
    renderBuilder();
    const dialog = screen.getByRole("dialog");

    for (let index = 0; index < 16; index += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("closes on Escape and restores focus when closing is allowed", async () => {
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
            <TradeBuilder
              proposer={0}
              players={PLAYERS}
              board={BOARD}
              validate={() => Promise.resolve(LEGAL)}
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

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  it("announces why it cannot close when there is no way out", async () => {
    const user = userEvent.setup();
    const { said } = renderBuilder();

    await user.keyboard("{Escape}");

    expect(said.map(({ politeness, key }) => ({ politeness, key }))).toEqual([
      { politeness: "polite", key: "trade.cannot_leave" },
    ]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("interaction floors", () => {
  it("mounts no live region of its own", () => {
    renderBuilder();
    const dialog = screen.getByRole("dialog");

    expect(dialog.querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(dialog.querySelectorAll('[role="status"], [role="alert"], [role="log"]')).toHaveLength(
      0,
    );
  });

  it("has no drag handler anywhere — selection is tap, click or Enter (GAP C2)", () => {
    renderBuilder({ renderDossier: (id) => <p>dossier for {id}</p> });
    const dialog = screen.getByRole("dialog");

    for (const attribute of [
      "draggable",
      "ondragstart",
      "ondragend",
      "ondragover",
      "ondrop",
      "ondragenter",
    ]) {
      expect(dialog.querySelectorAll(`[${attribute}]`)).toHaveLength(0);
    }
  });

  it("selects a property with the keyboard alone", async () => {
    const user = userEvent.setup();
    const { asked } = renderBuilder();
    const checkbox = within(tray("Ruti")).getByRole("checkbox", { name: /Mediterranean/ });

    checkbox.focus();
    await user.keyboard(" ");

    expect(checkbox).toBeChecked();
    await waitFor(() => {
      expect(asked).toHaveLength(1);
    });
  });

  it("uses no physical CSS property in its class names", () => {
    renderBuilder();

    const physical =
      /\b-?(?:ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|text-left|text-right|space-x|translate-x)-/;
    for (const element of screen.getByRole("dialog").querySelectorAll("*")) {
      expect(element.getAttribute("class") ?? "").not.toMatch(physical);
    }
  });

  it("asks the server once for a burst of taps, not once per tap", async () => {
    const { asked } = renderBuilder();
    const add = within(tray("Ruti")).getByRole("button", { name: "Add $10" });

    // `fireEvent` is synchronous, so all three land inside the debounce window — which is the
    // burst this is about. `userEvent` awaits between clicks and would not reproduce it.
    fireEvent.click(add);
    fireEvent.click(add);
    fireEvent.click(add);

    await waitFor(() => {
      expect(asked).toHaveLength(1);
    });
    expect(asked[0]).toMatchObject({ offer: { give: { cash: 30 } } });
  });
});
