/**
 * What must be true of the action bar, and what would be a silent disaster.
 *
 * The tests that earn their keep here are the ones that would go red if this component started
 * having opinions: the rendered set is *exactly* the legal set, a terminal command cannot fire
 * without a confirm, and nothing in the subtree announces anything. Everything else — that a
 * button says the right English words — is one assertion, because the catalogue is not the risk.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Command } from "@/api";
import { makeBoard, makeTile } from "@/test/fixtures";
import { COMMAND_KINDS, TERMINAL_COMMANDS } from "@/theme";

import { ActionBar, groupCommands } from "./ActionBar";
import { baseLabelKey, labelKeyFor } from "./actionCommand";

const BOARD = makeBoard({
  tiles: [
    makeTile(1, { name_key: "tile.classic.mediterranean_avenue" }),
    makeTile(3, { name_key: "tile.classic.baltic_avenue" }),
    makeTile(6, { name_key: "tile.classic.oriental_avenue", group: "light_blue" }),
  ],
});

const EMPTY_OFFER = {
  proposer: 0,
  recipient: 1,
  give: { cash: 0, tiles: [], jail_cards: [] },
  receive: { cash: 0, tiles: [], jail_cards: [] },
};

function renderBar(commands: readonly Command[], onCommand = vi.fn()) {
  render(<ActionBar commands={commands} onCommand={onCommand} board={BOARD} jailFine={50} />);
  return onCommand;
}

/** Every button in the bar that stands for a command, group affordances included. */
function commandButtons(): readonly HTMLElement[] {
  return screen
    .queryAllByRole("button")
    .filter((button) => button.dataset.commandKind !== undefined);
}

describe("one button per legal command", () => {
  it("renders exactly the legal set and nothing else", () => {
    renderBar([
      { kind: "roll_dice", player: 0 },
      { kind: "propose_trade", player: 0, offer: EMPTY_OFFER },
      { kind: "end_turn", player: 0, elapsed_seconds: null },
    ]);

    expect(commandButtons().map((button) => button.dataset.commandKind)).toEqual([
      "roll_dice",
      "propose_trade",
      "end_turn",
    ]);
  });

  it("keeps the engine's order rather than a notion of importance", () => {
    renderBar([
      { kind: "declare_bankruptcy", player: 0 },
      { kind: "roll_dice", player: 0 },
    ]);
    expect(commandButtons().map((button) => button.dataset.commandKind)).toEqual([
      "declare_bankruptcy",
      "roll_dice",
    ]);
  });

  it("renders no command button at all when the engine offered none", () => {
    renderBar([]);
    expect(commandButtons()).toHaveLength(0);
    expect(screen.getByText("No moves right now.")).toBeInTheDocument();
  });

  it("never disables a button — an absent move is the only way a move is unavailable", () => {
    renderBar([
      { kind: "roll_dice", player: 0 },
      { kind: "declare_bankruptcy", player: 0 },
    ]);
    for (const button of screen.getAllByRole("button")) {
      expect(button).not.toBeDisabled();
      expect(button).not.toHaveAttribute("aria-disabled");
    }
  });

  it("gives every button an icon as well as its words, and the words as its name", () => {
    renderBar([{ kind: "roll_dice", player: 0 }]);
    const button = screen.getByRole("button", { name: "Roll the dice" });
    // The glyph is a second channel for a pre-reader and must never be the accessible name.
    const glyphs = button.querySelectorAll("svg");
    expect(glyphs.length).toBeGreaterThan(0);
    for (const glyph of glyphs) {
      expect(glyph).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("submits the command object the engine handed it, unmodified", async () => {
    const command: Command = { kind: "roll_dice", player: 3 };
    const onCommand = renderBar([command]);
    await userEvent.click(screen.getByRole("button", { name: "Roll the dice" }));
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand.mock.calls[0]?.[0]).toBe(command);
  });

  it("labels a bid and bail from the command and the ruleset", () => {
    renderBar([
      { kind: "place_bid", player: 0, amount: 260 },
      { kind: "pay_jail_fine", player: 0 },
    ]);
    expect(screen.getByRole("button", { name: "Bid 260" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay 50 bail" })).toBeInTheDocument();
  });

  it("cannot render a kind it has no label for", () => {
    // The bridge is exhaustive by construction; this is the runtime restatement of that, so a raw
    // `build_house` reaching a child would be a red test rather than a screenshot somebody notices.
    for (const kind of COMMAND_KINDS) {
      expect(baseLabelKey(kind)).toBeTruthy();
    }
  });
});

describe("parameterised commands", () => {
  const builds: readonly Command[] = [
    { kind: "build_house", player: 0, tile: 1 },
    { kind: "build_house", player: 0, tile: 3 },
    { kind: "build_house", player: 0, tile: 6 },
  ];

  it("groups a tile-scoped kind behind one affordance", () => {
    renderBar(builds);
    const toggles = commandButtons();
    expect(toggles).toHaveLength(1);
    expect(toggles[0]).toHaveAttribute("aria-expanded", "false");
    expect(toggles[0]?.dataset.group).toBe("true");
    expect(within(toggles[0] as HTMLElement).getByText("3 squares")).toBeInTheDocument();
  });

  it("reveals one real target per legal square, each naming its square", async () => {
    const onCommand = renderBar(builds);
    await userEvent.click(screen.getByRole("button", { expanded: false }));

    const revealed = commandButtons().filter((button) => button.dataset.group === undefined);
    expect(revealed).toHaveLength(3);
    expect(revealed.map((button) => button.textContent)).toEqual([
      expect.stringContaining("Mediterranean Avenue"),
      expect.stringContaining("Baltic Avenue"),
      expect.stringContaining("Oriental Avenue"),
    ]);

    await userEvent.click(revealed[1] as HTMLElement);
    expect(onCommand).toHaveBeenCalledWith(builds[1]);
  });

  it("offers only squares that are in the legal set", async () => {
    // Two of the board's three squares are legal. The third must not appear, because the bar has no
    // idea which squares are buildable and must never guess.
    renderBar([builds[0] as Command, builds[2] as Command]);
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.queryByText(/Baltic Avenue/)).not.toBeInTheDocument();
    expect(screen.getByText(/Mediterranean Avenue/)).toBeInTheDocument();
    expect(screen.getByText(/Oriental Avenue/)).toBeInTheDocument();
  });

  it("closes on Escape and hands focus back to the affordance", async () => {
    renderBar(builds);
    const toggle = screen.getByRole("button", { expanded: false });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    await userEvent.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });

  it("leaves two commands of one kind side by side when they name no square", () => {
    // Accept and decline are the same kind and opposite answers. Collapsing them would hide one
    // behind a tap and label the group with whichever came first.
    renderBar([
      { kind: "respond_to_trade", player: 0, accept: true },
      { kind: "respond_to_trade", player: 0, accept: false },
    ]);
    expect(commandButtons()).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Accept the trade" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn down the trade" })).toBeInTheDocument();
  });

  it("does not collapse a single tile-scoped command", () => {
    renderBar([builds[0] as Command]);
    const [only] = commandButtons();
    expect(only?.dataset.group).toBeUndefined();
    expect(only?.textContent).toContain("Mediterranean Avenue");
  });
});

describe("groupCommands", () => {
  it("buckets by kind at first appearance without reordering across kinds", () => {
    const groups = groupCommands([
      { kind: "build_house", player: 0, tile: 1 },
      { kind: "end_turn", player: 0, elapsed_seconds: null },
      { kind: "build_house", player: 0, tile: 3 },
    ]);
    expect(groups.map((group) => group.kind)).toEqual(["build_house", "end_turn"]);
    expect(groups[0]?.commands).toHaveLength(2);
    expect(groups[0]?.collapsible).toBe(true);
    expect(groups[1]?.collapsible).toBe(false);
  });

  it("loses nothing it was given", () => {
    const commands: readonly Command[] = [
      { kind: "build_house", player: 0, tile: 1 },
      { kind: "mortgage_property", player: 0, tile: 1 },
      { kind: "build_house", player: 0, tile: 3 },
      { kind: "end_turn", player: 0, elapsed_seconds: null },
    ];
    const flattened = groupCommands(commands).flatMap((group) => group.commands);
    expect(flattened).toHaveLength(commands.length);
    expect(new Set(flattened)).toEqual(new Set(commands));
  });
});

describe("the confirm step", () => {
  const bankruptcy: Command = { kind: "declare_bankruptcy", player: 0 };

  it("blocks every terminal command until it is confirmed", async () => {
    for (const kind of TERMINAL_COMMANDS) {
      const onCommand = vi.fn();
      const command = { kind, player: 0 } as Command;
      const { unmount } = render(
        <ActionBar commands={[command]} onCommand={onCommand} board={BOARD} jailFine={50} />,
      );
      await userEvent.click(screen.getByRole("button", { name: /./ }));
      expect(onCommand, `${kind} fired without a confirm`).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      unmount();
    }
  });

  it("lets a reversible command through with no dialog at all", async () => {
    const onCommand = renderBar([{ kind: "roll_dice", player: 0 }]);
    await userEvent.click(screen.getByRole("button", { name: "Roll the dice" }));
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("states the consequence in plain language, not the label again", async () => {
    renderBar([bankruptcy]);
    await userEvent.click(screen.getByRole("button", { name: "Give up" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleDescription(/out of the game/i);
    expect(dialog).toHaveAccessibleDescription(/cannot be undone/i);
  });

  it("opens with focus on cancel, so Enter is the safe answer", async () => {
    renderBar([bankruptcy]);
    await userEvent.click(screen.getByRole("button", { name: "Give up" }));
    expect(screen.getByRole("button", { name: "No, go back" })).toHaveFocus();
  });

  it("sends the command only once the player says yes", async () => {
    const onCommand = renderBar([bankruptcy]);
    await userEvent.click(screen.getByRole("button", { name: "Give up" }));
    expect(onCommand).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /^Yes/ }));
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand.mock.calls[0]?.[0]).toBe(bankruptcy);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cancels on Escape without sending, and restores focus to the chit", async () => {
    const onCommand = renderBar([bankruptcy]);
    const chit = screen.getByRole("button", { name: "Give up" });
    await userEvent.click(chit);

    await userEvent.keyboard("{Escape}");
    expect(onCommand).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(chit).toHaveFocus();
  });

  it("cancels on the cancel button without sending", async () => {
    const onCommand = renderBar([bankruptcy]);
    await userEvent.click(screen.getByRole("button", { name: "Give up" }));
    await userEvent.click(screen.getByRole("button", { name: "No, go back" }));
    expect(onCommand).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("is reachable and answerable by keyboard alone", async () => {
    const onCommand = renderBar([bankruptcy]);
    // One Tab: the region itself is `tabIndex={-1}` (a focus *target* for the skip link, not a tab
    // stop), so the first stop in the bar is the chit.
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Give up" })).toHaveFocus();

    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Tab stays inside: two focusables, so one Tab reaches proceed and the next comes back.
    await userEvent.tab();
    expect(screen.getByRole("button", { name: /^Yes/ })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "No, go back" })).toHaveFocus();

    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: /^Yes/ })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onCommand).toHaveBeenCalledTimes(1);
  });

  it("names the action it is about to take on the proceed button", async () => {
    renderBar([bankruptcy]);
    await userEvent.click(screen.getByRole("button", { name: "Give up" }));
    // "Yes" alone is a button whose meaning lives in a heading a child has stopped reading.
    expect(screen.getByRole("button", { name: "Yes — Give up" })).toBeInTheDocument();
  });

  it("marks a terminal chit by shape as well as by tone", () => {
    renderBar([bankruptcy, { kind: "roll_dice", player: 0 }]);
    const [terminal, ordinary] = commandButtons();
    expect(terminal?.dataset.terminal).toBe("true");
    expect(terminal?.className).toContain("kesef-chit--terminal");
    expect(ordinary?.dataset.terminal).toBe("false");
    expect(ordinary?.className).not.toContain("kesef-chit--terminal");
  });
});

describe("the bar says nothing aloud", () => {
  it("renders no live region, and no role that implies one", async () => {
    const { container } = render(
      <ActionBar
        commands={[
          { kind: "declare_bankruptcy", player: 0 },
          { kind: "build_house", player: 0, tile: 1 },
          { kind: "build_house", player: 0, tile: 3 },
        ]}
        onCommand={vi.fn()}
        board={BOARD}
        jailFine={50}
      />,
    );
    // Opened states included: a dialog and a disclosure are exactly where a second live region
    // tends to get added. There is one Announcer in the product and this is not it (GAP D1/G-54).
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    await userEvent.click(screen.getByRole("button", { name: "Give up" }));

    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(container.querySelectorAll('[role="log"],[role="status"],[role="alert"]')).toHaveLength(
      0,
    );
  });
});

describe("the region", () => {
  it("carries the id Board's skip link points at, and can hold focus", () => {
    const { container } = render(
      <ActionBar commands={[]} onCommand={vi.fn()} board={BOARD} jailFine={50} />,
    );
    const region = container.querySelector("#kesef-actions");
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute("tabindex", "-1");
  });

  it("falls back to a placeholder name for a square the catalogue has never heard of", () => {
    // `board-israel` is a declared board with no catalogue until MON-503. One unnamed square must
    // not throw and take away every button in the bar.
    const israel = makeBoard({ id: "israel", tiles: [makeTile(1, { name_key: "tile.israel.x" })] });
    render(
      <ActionBar
        commands={[{ kind: "mortgage_property", player: 0, tile: 1 }]}
        onCommand={vi.fn()}
        board={israel}
        jailFine={50}
      />,
    );
    expect(screen.getByText("a square on the board")).toBeInTheDocument();
  });
});

describe("labelKeyFor, through the rendered bar", () => {
  it("uses the variant key for a hotel demolition", () => {
    renderBar([{ kind: "sell_house", player: 0, tile: 1, demolish_hotel: true }]);
    expect(labelKeyFor({ kind: "sell_house", player: 0, tile: 1, demolish_hotel: true })).toBe(
      "action.sell_house_hotel",
    );
    expect(screen.getByRole("button", { name: /Sell the hotel/ })).toBeInTheDocument();
  });
});

/**
 * MON-604 / MON-605: the three inputs that change what a chit *says* or how one is *marked*.
 *
 * All three are presentation, and for each the assertion that matters is the one proving it did not
 * become something else — that the rendered *set* of commands is identical with and without them. A
 * "kids mode" that quietly dropped a button is the ADR-005 violation these props could grow into.
 */
describe("Kids Mode wording and the hint mark", () => {
  const roll: Command = { kind: "roll_dice", player: 0 };
  const endTurn: Command = { kind: "end_turn", player: 0, elapsed_seconds: null };

  function kinds(): readonly (string | undefined)[] {
    return commandButtons().map((button) => button.dataset.commandKind);
  }

  it("prefers the simpler label where the catalogue has one", () => {
    render(<ActionBar commands={[roll]} onCommand={vi.fn()} board={BOARD} jailFine={50} kids />);
    expect(screen.getByRole("button", { name: "Throw the dice" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Roll the dice" })).not.toBeInTheDocument();
  });

  it("renders exactly the same commands in a kids game as in a full one", () => {
    const bankruptcy: Command = { kind: "declare_bankruptcy", player: 0 };
    const commands = [roll, endTurn, bankruptcy];
    const { unmount } = render(
      <ActionBar commands={commands} onCommand={vi.fn()} board={BOARD} jailFine={50} />,
    );
    const full = kinds();
    unmount();

    render(<ActionBar commands={commands} onCommand={vi.fn()} board={BOARD} jailFine={50} kids />);
    expect(kinds()).toEqual(full);
  });

  it("tells the truth about declining when the rule set has no auctions", async () => {
    const decline: Command = { kind: "decline_purchase", player: 0 };
    render(
      <ActionBar
        commands={[decline]}
        onCommand={vi.fn()}
        board={BOARD}
        jailFine={50}
        auctions={false}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /buy/i }));
    // The universal sentence promises an auction. In a kids game there is none, and the dialog in
    // front of the child must not describe a rule the table is not playing.
    expect(screen.getByRole("dialog")).not.toHaveAccessibleDescription(/auction/i);
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(/stays on the market/i);
  });

  it("marks the hinted chit, and only that one", () => {
    render(
      <ActionBar
        commands={[roll, endTurn]}
        onCommand={vi.fn()}
        board={BOARD}
        jailFine={50}
        hinted={roll}
      />,
    );
    const buttons = commandButtons();
    const rollChit = buttons[0];
    expect(rollChit?.dataset.hinted).toBe("true");
    expect(buttons[1]?.dataset.hinted).toBe("false");
    // Words as well as a rim: the badge is the channel a screen reader and a greyscale display share.
    expect(rollChit).not.toBeUndefined();
    expect(within(rollChit as HTMLElement).getByTestId("hint-badge")).toHaveTextContent(
      "Suggested",
    );
  });

  it("marks nothing when the hint layer is quiet", () => {
    renderBar([roll, endTurn]);
    expect(screen.queryAllByTestId("hint-badge")).toHaveLength(0);
  });

  it("ignores a hinted command that is not one of the ones offered", () => {
    // `hinted` is compared by identity against `commands`, which is what makes it impossible for a
    // stale or fabricated value to mark — or appear to offer — anything. Structurally identical and
    // still not marked, which is the whole point.
    const elsewhere: Command = { kind: "roll_dice", player: 0 };
    render(
      <ActionBar
        commands={[roll]}
        onCommand={vi.fn()}
        board={BOARD}
        jailFine={50}
        hinted={elsewhere}
      />,
    );
    expect(screen.queryAllByTestId("hint-badge")).toHaveLength(0);
  });

  it("marks a collapsed group whose hidden member is the hinted one", () => {
    const houses: readonly Command[] = [
      { kind: "build_house", player: 0, tile: 1 },
      { kind: "build_house", player: 0, tile: 3 },
    ];
    render(
      <ActionBar
        commands={houses}
        onCommand={vi.fn()}
        board={BOARD}
        jailFine={50}
        hinted={houses[1]}
      />,
    );
    // Otherwise the badge is invisible until the group is opened — the one state a child most needs
    // it in.
    const toggle = screen.getByRole("button", { expanded: false });
    expect(toggle.dataset.hinted).toBe("true");
    expect(within(toggle).getByTestId("hint-badge")).toBeInTheDocument();
  });

  it("never disables anything on account of a hint", () => {
    render(
      <ActionBar
        commands={[roll, endTurn]}
        onCommand={vi.fn()}
        board={BOARD}
        jailFine={50}
        hinted={roll}
        kids
      />,
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button).not.toBeDisabled();
      expect(button).not.toHaveAttribute("aria-disabled");
    }
  });
});
