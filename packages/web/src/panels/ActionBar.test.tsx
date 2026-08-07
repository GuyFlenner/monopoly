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

import type { Command, Phase } from "@/api";
import { makeBoard, makeTile } from "@/test/fixtures";
import { COMMAND_KINDS, NEVER_COLLAPSED, TERMINAL_COMMANDS } from "@/theme";

import { ACTIONS_REGION_ID, ActionBar, groupCommands, zoneCommands } from "./ActionBar";
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

/** One chit per command — the group toggles, which stand for several, excluded. */
function chits(): readonly HTMLElement[] {
  return commandButtons().filter((button) => button.dataset.group === undefined);
}

/**
 * Open everything the bar has folded, until nothing reports itself collapsed.
 *
 * Bounded rather than `while (true)`: a fold that reports `aria-expanded="false"` and does not open is
 * exactly the defect the reachability suite is looking for, and it should fail as an assertion rather
 * than hang the run.
 */
async function revealEverything(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    const folded = screen.queryAllByRole("button", { expanded: false });
    if (folded.length === 0) {
      return;
    }
    for (const button of folded) {
      await userEvent.click(button);
    }
  }
  expect(
    screen.queryAllByRole("button", { expanded: false }),
    "something stayed folded after four rounds of opening it",
  ).toHaveLength(0);
}

/** Answer a MON-405 confirm dialog affirmatively, if one is up. */
async function proceedThroughAnyConfirm(): Promise<void> {
  const proceed = document.querySelector<HTMLButtonElement>('[data-confirm="proceed"]');
  if (proceed !== null) {
    await userEvent.click(proceed);
  }
}

describe("one button per legal command", () => {
  it("renders exactly the legal set and nothing else", async () => {
    // The set, not the DOM order — which is the property this file now states. `propose_trade` is an
    // estate command and `roll_dice`/`end_turn` are turn flow, so with both zones occupied the estate
    // one arrives folded; opening it must produce the third chit and no fourth.
    renderBar([
      { kind: "roll_dice", player: 0 },
      { kind: "propose_trade", player: 0, offer: EMPTY_OFFER },
      { kind: "end_turn", player: 0, elapsed_seconds: null },
    ]);

    expect(commandButtons().map((button) => button.dataset.commandKind)).toEqual([
      "roll_dice",
      "end_turn",
    ]);

    await revealEverything();
    expect(new Set(commandButtons().map((button) => button.dataset.commandKind))).toEqual(
      new Set(["roll_dice", "end_turn", "propose_trade"]),
    );
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
    expect(screen.getByRole("button", { name: "Bid $260" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay $50 bail" })).toBeInTheDocument();
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
  /*
    `mortgage_property` rather than `build_house` since MON-724: building is in `NEVER_COLLAPSED`, so
    it is no longer an example of this mechanism. The mechanism itself is unchanged and still needs
    holding down — see the `build_house` suite below for the exemption's own tests.
  */
  const mortgages: readonly Command[] = [
    { kind: "mortgage_property", player: 0, tile: 1 },
    { kind: "mortgage_property", player: 0, tile: 3 },
    { kind: "mortgage_property", player: 0, tile: 6 },
  ];

  it("groups a tile-scoped kind behind one affordance", () => {
    renderBar(mortgages);
    const toggles = commandButtons();
    expect(toggles).toHaveLength(1);
    expect(toggles[0]).toHaveAttribute("aria-expanded", "false");
    expect(toggles[0]?.dataset.group).toBe("true");
    expect(within(toggles[0] as HTMLElement).getByText("3 squares")).toBeInTheDocument();
  });

  it("reveals one real target per legal square, each naming its square", async () => {
    const onCommand = renderBar(mortgages);
    await userEvent.click(screen.getByRole("button", { expanded: false }));

    const revealed = commandButtons().filter((button) => button.dataset.group === undefined);
    expect(revealed).toHaveLength(3);
    expect(revealed.map((button) => button.textContent)).toEqual([
      expect.stringContaining("Mediterranean Avenue"),
      expect.stringContaining("Baltic Avenue"),
      expect.stringContaining("Oriental Avenue"),
    ]);

    await userEvent.click(revealed[1] as HTMLElement);
    expect(onCommand).toHaveBeenCalledWith(mortgages[1]);
  });

  it("offers only squares that are in the legal set", async () => {
    // Two of the board's three squares are legal. The third must not appear, because the bar has no
    // idea which squares are mortgageable and must never guess.
    renderBar([mortgages[0] as Command, mortgages[2] as Command]);
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.queryByText(/Baltic Avenue/)).not.toBeInTheDocument();
    expect(screen.getByText(/Mediterranean Avenue/)).toBeInTheDocument();
    expect(screen.getByText(/Oriental Avenue/)).toBeInTheDocument();
  });

  it("closes on Escape and hands focus back to the affordance", async () => {
    renderBar(mortgages);
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
    renderBar([mortgages[0] as Command]);
    const [only] = commandButtons();
    expect(only?.dataset.group).toBeUndefined();
    expect(only?.textContent).toContain("Mediterranean Avenue");
  });
});

/**
 * The reported defect, as the position that produced it (MON-724).
 *
 * An owner who had just completed a colour group could not find building at all. What they saw on
 * arrival was two buttons: the dice, and an 11px collapsed heading reading "Your properties · 6
 * moves". Reaching a build took three presses, and neither of the first two said "build".
 *
 * So the assertion is about **arrival**, with no `revealEverything()` and no click: the streets are
 * pressable the moment the view lands. That is a different claim from the reachability suite below,
 * which proves nothing is *lost*; this one proves the growth move is not merely reachable.
 */
describe("a completed colour group announces itself", () => {
  /** `legal_commands` as the engine returns it in `AWAITING_ROLL` for the owner of a whole group. */
  const wholeGroup: readonly Command[] = [
    { kind: "build_house", player: 0, tile: 1 },
    { kind: "build_house", player: 0, tile: 3 },
    { kind: "build_house", player: 0, tile: 6 },
    { kind: "mortgage_property", player: 0, tile: 1 },
    { kind: "mortgage_property", player: 0, tile: 3 },
    { kind: "roll_dice", player: 0 },
  ];

  function renderTurn(commands: readonly Command[] = wholeGroup, phase: Phase = "awaiting_roll") {
    const onCommand = vi.fn();
    render(
      <ActionBar
        commands={commands}
        onCommand={onCommand}
        board={BOARD}
        jailFine={50}
        phase={phase}
      />,
    );
    return onCommand;
  }

  it("offers a build on every legal street with nothing folded over it", () => {
    renderTurn();
    const builds = chits().filter((chit) => chit.dataset.commandKind === "build_house");
    expect(builds).toHaveLength(3);
    expect(builds.map((chit) => chit.textContent)).toEqual([
      expect.stringContaining("Mediterranean Avenue"),
      expect.stringContaining("Baltic Avenue"),
      expect.stringContaining("Oriental Avenue"),
    ]);
  });

  it("sends the engine's own command for the street pressed, first press", async () => {
    const onCommand = renderTurn();
    const builds = chits().filter((chit) => chit.dataset.commandKind === "build_house");
    await userEvent.click(builds[2] as HTMLElement);
    // By identity: the object the engine offered for tile 6, not one this bar assembled.
    expect(onCommand).toHaveBeenCalledWith(wholeGroup[2]);
  });

  it("opens the estate zone for a build even though the phase says flow", () => {
    renderTurn();
    const fold = document.querySelector<HTMLElement>('[data-zone="portfolio"]');
    expect(fold, "the estate zone should be a fold here — both zones are occupied").not.toBeNull();
    expect(fold).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the estate folded on a turn with no build in it", () => {
    // The MON-711 demotion, undisturbed: mortgage alone does not earn the zone being open.
    renderTurn(
      [
        { kind: "mortgage_property", player: 0, tile: 1 },
        { kind: "roll_dice", player: 0 },
      ],
      "awaiting_roll",
    );
    expect(document.querySelector('[data-zone="portfolio"]')).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("still collapses the mortgages beside the flattened builds", () => {
    // The exemption is one kind wide. Two mortgageable squares are still one affordance.
    renderTurn();
    const groups = commandButtons().filter((button) => button.dataset.group === "true");
    expect(groups.map((button) => button.dataset.commandKind)).toEqual(["mortgage_property"]);
  });
});

/**
 * Whose move a chit acts for (MON-726).
 *
 * `legal_commands` answers for every seat that may act (MON-204), so on one shared screen two
 * players' builds arrive in one list — and before this they were rows nothing distinguished. The bar
 * is told the words by `game/seatedCommands.ts`; what is tested here is that it renders them and
 * still hands back the same objects.
 */
describe("the seat a chit acts for", () => {
  const twoSeats: readonly Command[] = [
    { kind: "roll_dice", player: 0 },
    { kind: "build_house", player: 0, tile: 1 },
    { kind: "build_house", player: 1, tile: 3 },
  ];

  /** Stands in for `actingFor(players, current)`: seat 1 is not the one being waited on. */
  const naming = (command: Command): string | undefined =>
    command.player === 1 ? "Dan" : undefined;

  function renderNamed(onCommand = vi.fn()) {
    render(
      <ActionBar
        commands={twoSeats}
        onCommand={onCommand}
        board={BOARD}
        jailFine={50}
        actingFor={naming}
        phase="awaiting_roll"
      />,
    );
    return onCommand;
  }

  it("names the other seat beside the square, in one reading", () => {
    renderNamed();
    const [own, other] = chits().filter((chit) => chit.dataset.commandKind === "build_house");
    expect(within(own as HTMLElement).getByTestId("chit-subline")).toHaveTextContent(
      "Mediterranean Avenue",
    );
    expect(within(other as HTMLElement).getByTestId("chit-subline")).toHaveTextContent(
      "Dan · Baltic Avenue",
    );
  });

  it("leaves the seat being waited on unlabelled", () => {
    // A label on every row is a label nobody reads; `TurnBanner` already says whose turn it is.
    renderNamed();
    const own = chits().find((chit) => chit.dataset.commandKind === "roll_dice");
    expect(own?.textContent).toBe("Roll the dice");
  });

  it("still delivers the engine's own object when the labelled chit is pressed", async () => {
    // The label is a word on a span. It must not become a wrapper that reconstructs the command.
    const onCommand = renderNamed();
    const other = chits().find((chit) => chit.textContent.includes("Dan")) as HTMLElement;
    await userEvent.click(other);
    expect(onCommand).toHaveBeenCalledWith(twoSeats[2]);
  });

  it("labels nothing at all when the caller names no seats", () => {
    // Every other test in this file renders without the prop, so this is the default they rely on.
    renderBar(twoSeats);
    for (const chit of chits()) {
      expect(chit.textContent).not.toContain("Dan");
    }
  });
});

describe("groupCommands", () => {
  it("buckets by kind at first appearance without reordering across kinds", () => {
    const groups = groupCommands([
      { kind: "mortgage_property", player: 0, tile: 1 },
      { kind: "end_turn", player: 0, elapsed_seconds: null },
      { kind: "mortgage_property", player: 0, tile: 3 },
    ]);
    expect(groups.map((group) => group.kind)).toEqual(["mortgage_property", "end_turn"]);
    expect(groups[0]?.commands).toHaveLength(2);
    expect(groups[0]?.collapsible).toBe(true);
    expect(groups[1]?.collapsible).toBe(false);
  });

  it("never collapses a kind the theme exempts, however many squares it holds", () => {
    // MON-724. Asserted through `NEVER_COLLAPSED` rather than by naming `build_house`, so a second
    // exempt kind cannot land without this test covering it.
    for (const kind of NEVER_COLLAPSED) {
      const groups = groupCommands([
        { kind, player: 0, tile: 1 },
        { kind, player: 0, tile: 3 },
        { kind, player: 0, tile: 6 },
      ] as readonly Command[]);
      expect(groups[0]?.commands, `${kind} lost a command`).toHaveLength(3);
      expect(groups[0]?.collapsible, `${kind} collapsed`).toBe(false);
    }
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

/**
 * MON-UX1: the bar splits into two labelled zones, and this is the suite that has to be convincing.
 *
 * `docs/UX_ACTION_PROMINENCE.md` §5. The claim the old suite made — DOM order equals array order — is
 * gone on purpose, and the claim replacing it is stronger and harder to satisfy by accident: **every
 * command the engine offered is present and operable**. That is asserted by opening every fold,
 * counting the chits, then clicking each one and comparing what arrived at `onCommand` against the
 * input *by identity*.
 *
 * The positions are the shape `legal_commands` has when each phase is live, including the alphabetical
 * interleaving `legality.py`'s `_sort_key` produces — which is the thing that put `mortgage_property`
 * above `roll_dice` and started this.
 */
const POSITIONS: readonly { readonly phase: Phase; readonly commands: readonly Command[] }[] = [
  {
    phase: "awaiting_roll",
    commands: [
      { kind: "build_house", player: 0, tile: 1 },
      { kind: "mortgage_property", player: 0, tile: 1 },
      { kind: "mortgage_property", player: 0, tile: 3 },
      { kind: "roll_dice", player: 0 },
      { kind: "sell_house", player: 0, tile: 1, demolish_hotel: false },
      { kind: "unmortgage_property", player: 0, tile: 6 },
    ],
  },
  {
    phase: "awaiting_end_turn",
    commands: [
      { kind: "end_turn", player: 0, elapsed_seconds: null },
      { kind: "mortgage_property", player: 0, tile: 1 },
      { kind: "sell_house", player: 0, tile: 3, demolish_hotel: false },
      { kind: "unmortgage_property", player: 0, tile: 6 },
    ],
  },
  {
    phase: "awaiting_purchase_decision",
    commands: [
      { kind: "buy_property", player: 0 },
      { kind: "decline_purchase", player: 0 },
    ],
  },
  {
    phase: "jail_decision",
    commands: [
      { kind: "mortgage_property", player: 0, tile: 1 },
      { kind: "pay_jail_fine", player: 0 },
      { kind: "roll_for_jail", player: 0 },
      { kind: "use_jail_card", player: 0 },
    ],
  },
  {
    phase: "auction",
    commands: [
      { kind: "mortgage_property", player: 1, tile: 1 },
      { kind: "mortgage_property", player: 1, tile: 3 },
      { kind: "place_bid", player: 1, amount: 120 },
      { kind: "sell_house", player: 1, tile: 6, demolish_hotel: false },
      { kind: "withdraw_from_auction", player: 1 },
    ],
  },
  {
    // The position the whole feature could have broken: raising cash *is* the point here, and every
    // way of doing it has to be in front of the debtor rather than behind a fold.
    phase: "debt_settlement",
    commands: [
      { kind: "declare_bankruptcy", player: 2 },
      { kind: "mortgage_property", player: 2, tile: 1 },
      { kind: "mortgage_property", player: 2, tile: 3 },
      { kind: "propose_trade", player: 2, offer: EMPTY_OFFER },
      { kind: "sell_house", player: 2, tile: 6, demolish_hotel: false },
    ],
  },
  {
    phase: "trade_review",
    commands: [
      { kind: "cancel_trade", player: 0 },
      { kind: "respond_to_trade", player: 1, accept: true },
      { kind: "respond_to_trade", player: 1, accept: false },
    ],
  },
];

describe("nothing the engine offered can become unreachable", () => {
  for (const position of POSITIONS) {
    it(`offers and delivers every legal command in ${position.phase}`, async () => {
      const received: Command[] = [];
      render(
        <ActionBar
          commands={position.commands}
          onCommand={(command) => {
            received.push(command);
          }}
          board={BOARD}
          jailFine={50}
          phase={position.phase}
        />,
      );

      await revealEverything();

      // Presence. A zoning bug that dropped a whole zone's members fails here.
      expect(chits(), `${position.phase}: a chit is missing`).toHaveLength(
        position.commands.length,
      );

      // Operability, which is what "reachable" has to mean. Identity, not shape: a chit bound to a
      // reconstructed command would pass a structural comparison and fail this.
      for (const chit of chits()) {
        await userEvent.click(chit);
        await proceedThroughAnyConfirm();
      }
      expect(new Set(received)).toEqual(new Set(position.commands));
    });
  }

  it("puts the raising moves in front of a debtor rather than behind a fold", () => {
    const debt = POSITIONS.find((position) => position.phase === "debt_settlement");
    render(
      <ActionBar
        commands={debt?.commands ?? []}
        onCommand={vi.fn()}
        board={BOARD}
        jailFine={50}
        phase="debt_settlement"
      />,
    );
    // Open on arrival, with no gesture at all — the whole reason the emphasis table exists.
    expect(screen.getByRole("button", { name: /properties/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // What may still be folded is a *kind* group — two mortgageable squares behind one affordance,
    // which is the pre-existing "which of my streets" disclosure and not the zone. The zone itself is
    // never among them.
    for (const folded of screen.queryAllByRole("button", { expanded: false })) {
      expect(folded.dataset.group, "the estate zone stayed folded in debt settlement").toBe("true");
    }
  });
});

describe("the two zones", () => {
  /*
    Two *raising* estate moves since MON-724. This suite is about the MON-711 demotion — the estate
    arriving folded on an ordinary turn — and `build_house` is now the one estate kind that overrides
    exactly that, so using it here would be testing the override rather than the demotion. The
    override has its own suite above.
  */
  const flowAndEstate: readonly Command[] = [
    { kind: "sell_house", player: 0, tile: 1, demolish_hotel: false },
    { kind: "mortgage_property", player: 0, tile: 3 },
    { kind: "roll_dice", player: 0 },
  ];

  /** The estate zone's affordance. `data-zone` marks it; it carries no `data-command-kind`. */
  function fold(): HTMLElement {
    const element = document.querySelector<HTMLElement>('[data-zone="portfolio"]');
    expect(element, "the estate zone has no affordance").not.toBeNull();
    return element as HTMLElement;
  }

  it("shows the turn's own move first and folds the estate away behind a label", () => {
    renderBar(flowAndEstate);

    // The complaint, inverted: in the engine's own order `mortgage_property` precedes `roll_dice`,
    // because the sort is alphabetical by kind.
    expect(chits().map((button) => button.dataset.commandKind)).toEqual(["roll_dice"]);
    expect(fold()).toHaveAttribute("aria-expanded", "false");
    expect(fold()).toHaveTextContent("Your properties");
    // The count is the legal set's, so a fold can never under-report what it holds.
    expect(fold()).toHaveTextContent("2 moves");
  });

  it("names both halves, as headings a screen reader can navigate by", () => {
    renderBar(flowAndEstate);
    expect(screen.getByRole("heading", { name: "Waiting on you" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Your properties/ })).toBeInTheDocument();
    // Under the bar's own h2, not beside it.
    expect(screen.getByRole("heading", { name: "Moves" }).tagName).toBe("H2");
    expect(screen.getByRole("heading", { name: "Waiting on you" }).tagName).toBe("H3");
  });

  it("stays a flat list when only one zone is occupied", () => {
    // A purchase decision, an auction, a trade review: two headings over one button is scaffolding to
    // read past, so the bar renders exactly what it always did.
    renderBar([
      { kind: "buy_property", player: 0 },
      { kind: "decline_purchase", player: 0 },
    ]);
    expect(document.querySelector("[data-zone]")).toBeNull();
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
    expect(chits()).toHaveLength(2);
  });

  it("stays a flat list when the estate is all there is", () => {
    // Nothing to demote it relative to, so nothing is folded — and this is the case the existing
    // grouping tests all render.
    renderBar([
      { kind: "mortgage_property", player: 0, tile: 1 },
      { kind: "mortgage_property", player: 0, tile: 3 },
    ]);
    expect(document.querySelector('[data-zone="portfolio"]')).toBeNull();
  });

  it("never folds the flow zone", () => {
    renderBar(flowAndEstate);
    expect(document.querySelector('[data-zone="flow"]')).toBeNull();
  });

  it("keeps the engine's order inside a zone", () => {
    renderBar([
      { kind: "end_turn", player: 0, elapsed_seconds: null },
      { kind: "pay_jail_fine", player: 0 },
      { kind: "mortgage_property", player: 0, tile: 1 },
    ]);
    // Only the *interleaving* of the two zones changes. Relative order within one is untouched.
    expect(chits().map((button) => button.dataset.commandKind)).toEqual([
      "end_turn",
      "pay_jail_fine",
    ]);
  });

  it("sends no command when the fold itself is pressed", async () => {
    const onCommand = renderBar(flowAndEstate);
    await userEvent.click(fold());
    expect(onCommand).not.toHaveBeenCalled();
    expect(fold()).toHaveAttribute("aria-expanded", "true");
  });

  it("closes on Escape and hands focus back to the fold", async () => {
    renderBar(flowAndEstate);
    await userEvent.click(fold());
    await userEvent.keyboard("{Escape}");
    expect(fold()).toHaveAttribute("aria-expanded", "false");
    // The collapse and the focus are guaranteed to be in the same place, which is how focus cannot
    // reach `<body>` — the failure this repo has shipped twice.
    expect(fold()).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("opens on arrival when the phase makes the estate the point, and never shuts itself again", () => {
    const { rerender } = render(
      <ActionBar
        commands={flowAndEstate}
        onCommand={vi.fn()}
        board={BOARD}
        jailFine={50}
        phase="debt_settlement"
      />,
    );
    expect(fold()).toHaveAttribute("aria-expanded", "true");

    // Emphasis is monotonic: the debt is settled, the phase moves on, and the zone stays open rather
    // than unmounting a chit that might have focus.
    rerender(
      <ActionBar
        commands={flowAndEstate}
        onCommand={vi.fn()}
        board={BOARD}
        jailFine={50}
        phase="awaiting_roll"
      />,
    );
    expect(fold()).toHaveAttribute("aria-expanded", "true");
  });

  it("respects a player who folds the estate away mid-debt", async () => {
    render(
      <ActionBar
        commands={flowAndEstate}
        onCommand={vi.fn()}
        board={BOARD}
        jailFine={50}
        phase="debt_settlement"
      />,
    );
    await userEvent.click(fold());
    expect(fold()).toHaveAttribute("aria-expanded", "false");
    // They asked. The commands are one keystroke away and the count still says what is inside.
    expect(fold()).toHaveTextContent("2 moves");
  });

  it("disables nothing, folded or open", async () => {
    renderBar(flowAndEstate);
    await revealEverything();
    for (const button of screen.getAllByRole("button")) {
      expect(button).not.toBeDisabled();
      expect(button).not.toHaveAttribute("aria-disabled");
    }
  });

  it("gives the fold the same hit-target floor as a chit", () => {
    renderBar(flowAndEstate);
    // `.target` is what `data-comfort` scales — 44 px, or 56 in Kids Mode. A control that opted out
    // of the class would be a 20 px row for a six-year-old.
    expect(fold().className).toContain("target");
  });

  it("carries the hint's badge when the marked command is folded away", () => {
    // A raising move, so the zone really is folded — see the note on `flowAndEstate`.
    const deeds: readonly Command[] = [
      { kind: "roll_dice", player: 0 },
      { kind: "mortgage_property", player: 0, tile: 1 },
    ];
    render(
      <ActionBar
        commands={deeds}
        onCommand={vi.fn()}
        board={BOARD}
        jailFine={50}
        hinted={deeds[1]}
        phase="awaiting_roll"
      />,
    );
    // Exactly as a collapsed *kind* group carries it: the badge is invisible until the fold is opened,
    // which is the one state a child most needs it in.
    expect(fold().dataset.hinted).toBe("true");
    expect(within(fold()).getByTestId("hint-badge")).toHaveTextContent("Suggested");
  });

  it("does not mark the fold when the hint points at something in the open", () => {
    const commands: readonly Command[] = [
      { kind: "roll_dice", player: 0 },
      { kind: "mortgage_property", player: 0, tile: 1 },
    ];
    render(
      <ActionBar
        commands={commands}
        onCommand={vi.fn()}
        board={BOARD}
        jailFine={50}
        hinted={commands[0]}
        phase="awaiting_roll"
      />,
    );
    expect(fold().dataset.hinted).toBe("false");
  });
});

describe("zoneCommands", () => {
  const mixed: readonly Command[] = [
    { kind: "build_house", player: 0, tile: 1 },
    { kind: "mortgage_property", player: 0, tile: 1 },
    { kind: "roll_dice", player: 0 },
    { kind: "sell_house", player: 0, tile: 3, demolish_hotel: false },
  ];

  it("loses nothing it was given", () => {
    const flattened = zoneCommands(mixed).flatMap((zone) => zone.commands);
    expect(flattened).toHaveLength(mixed.length);
    expect(new Set(flattened)).toEqual(new Set(mixed));
  });

  it("puts flow first and preserves the engine's order inside each zone", () => {
    const zones = zoneCommands(mixed);
    expect(zones.map((zone) => zone.zone)).toEqual(["flow", "portfolio"]);
    expect(zones[0]?.commands).toEqual([mixed[2]]);
    expect(zones[1]?.commands).toEqual([mixed[0], mixed[1], mixed[3]]);
  });

  it("omits a zone nothing landed in", () => {
    expect(zoneCommands([{ kind: "roll_dice", player: 0 }]).map((zone) => zone.zone)).toEqual([
      "flow",
    ]);
    expect(zoneCommands([])).toHaveLength(0);
  });

  it("still groups a tile-scoped kind inside its zone", () => {
    const zones = zoneCommands([
      { kind: "roll_dice", player: 0 },
      { kind: "mortgage_property", player: 0, tile: 1 },
      { kind: "mortgage_property", player: 0, tile: 3 },
    ]);
    expect(zones[1]?.groups).toHaveLength(1);
    expect(zones[1]?.groups[0]?.collapsible).toBe(true);
  });

  it("carries the never-collapsed exemption into a zone as well (MON-724)", () => {
    // The zoning pass rebuilds the groups per zone, so the exemption has to survive that rebuild and
    // not only `groupCommands` in isolation.
    const zones = zoneCommands([
      { kind: "roll_dice", player: 0 },
      { kind: "build_house", player: 0, tile: 1 },
      { kind: "build_house", player: 0, tile: 3 },
    ]);
    expect(zones[1]?.groups[0]?.collapsible).toBe(false);
    expect(zones[1]?.groups[0]?.commands).toHaveLength(2);
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
    // Opened states included: a dialog and both kinds of disclosure — the estate zone and a collapsed
    // kind group inside it — are exactly where a second live region tends to get added, and the zone's
    // expand/collapse is the newest candidate. There is one Announcer in the product and this is not
    // it (GAP D1/G-54).
    await revealEverything();
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

  it("sends a decline straight through when there is no auction to lose the square to", async () => {
    /*
      MON-718, and the assertion that replaced one of this file's own (git history has it).

      The old test asserted a *second* consequence sentence for a table with no auctions, on the
      argument that a dialog must not describe a rule the table is not playing. That argument now
      lands somewhere better: with `auctions_enabled` off, declining is not irreversible at all — the
      square stays unsold and the next player to stop there may buy it — so the honest answer is no
      dialog, not a gentler one. The owner reported the interruption; this is what removing it looks
      like from the outside.
    */
    const decline: Command = { kind: "decline_purchase", player: 0 };
    const onCommand = vi.fn();
    render(
      <ActionBar
        commands={[decline]}
        onCommand={onCommand}
        board={BOARD}
        jailFine={50}
        auctions={false}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /buy/i }));

    expect(screen.queryByRole("dialog"), "a dialog appeared for a reversible decline").toBeNull();
    expect(onCommand).toHaveBeenCalledWith(decline);
    // And the chit does not wear the dashed terminal rim either: what it looks like and what it does
    // are one answer, so a chit cannot promise a dialog it will not open.
    const chit = screen.getByRole("button", { name: /buy/i });
    expect(chit).toHaveAttribute("data-terminal", "false");
    expect(chit.className).not.toContain("kesef-chit--terminal");
  });

  it("still confirms a decline at a table that turned auctions on", async () => {
    // The other half, and the reason `requiresConfirmation` takes the ruleset rather than losing the
    // dialog outright: with auctions on, a mis-tap really can hand the deed to somebody for a pound.
    const decline: Command = { kind: "decline_purchase", player: 0 };
    const onCommand = vi.fn();
    render(
      <ActionBar
        commands={[decline]}
        onCommand={onCommand}
        board={BOARD}
        jailFine={50}
        auctions={true}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /buy/i }));

    expect(onCommand, "the command was sent before the player answered").not.toHaveBeenCalled();
    // The one sentence there is, and it is true of this table: the square goes to auction.
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(/auction/i);
    // By kind, not by name: with the dialog open its own "proceed" button carries the action label
    // too, so a name query now matches two buttons.
    expect(document.querySelector('[data-command-kind="decline_purchase"]')).toHaveAttribute(
      "data-terminal",
      "true",
    );
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
    // A collapsing kind, which `build_house` no longer is (MON-724).
    const deeds: readonly Command[] = [
      { kind: "mortgage_property", player: 0, tile: 1 },
      { kind: "mortgage_property", player: 0, tile: 3 },
    ];
    render(
      <ActionBar
        commands={deeds}
        onCommand={vi.fn()}
        board={BOARD}
        jailFine={50}
        hinted={deeds[1]}
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

/**
 * The keyboard, after a press that takes the pressed button away (MON-703).
 *
 * This bar is rebuilt from `legal_commands` after every command — that is the ADR-005 design — so
 * pressing Roll removes the roll chit. It used to take the focus with it: `document.activeElement`
 * became `<body>`, and from there Tab starts again at the top of the page. Found by
 * `e2e/keyboard.spec.ts`; asserted here as well, because this is the component that owns the repair and
 * a browser test is a slow place to notice it has been removed.
 */
describe("focus after a press that removes the chit", () => {
  const roll: Command = { kind: "roll_dice", player: 0 };
  const endTurn: Command = { kind: "end_turn", player: 0, elapsed_seconds: null };

  function bar(commands: readonly Command[]) {
    return <ActionBar commands={commands} onCommand={vi.fn()} board={BOARD} jailFine={50} />;
  }

  it("lands in the bar rather than on the body when the pressed chit unmounts", async () => {
    const { rerender } = render(bar([roll, endTurn]));
    const chit = screen.getByRole("button", { name: /Roll the dice/ });
    chit.focus();
    await userEvent.click(chit);

    // The engine’s answer arrives and the roll is no longer legal, so React removes the button that
    // was pressed. This is the exact commit that used to strand the keyboard.
    rerender(bar([endTurn]));

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.id, "focus did not land on the bar").toBe("kesef-actions");
  });

  it("catches the focus without scrolling the page to itself (MON-729)", async () => {
    /*
      The owner's report: *"every time we see a card the game scrolls down, and we have to scroll back
      up."* `focus()` scrolls the focused element into view, and this bar sits in the aside column —
      below the board on a narrow screen — so the repair above was dragging the page down on **every**
      press. A card is only what made it noticeable: it is the one thing that appears on the board and
      stays there for seconds, so it is the one time the player is looking somewhere the scroll takes
      them away from.

      Asserted on the *option* rather than on a scroll position, because jsdom has no layout and never
      scrolls — a test written against `scrollTop` here would pass with the defect fully present.
    */
    // No `mockImplementation`: `spyOn` calls through, so the focus really moves and the assertion
    // about `activeElement` below is about the product rather than about the spy.
    const spy = vi.spyOn(HTMLElement.prototype, "focus");

    try {
      const { rerender } = render(bar([roll, endTurn]));
      const chit = screen.getByRole("button", { name: /Roll the dice/ });
      chit.focus();
      await userEvent.click(chit);
      rerender(bar([endTurn]));

      // The repair still happened...
      expect(document.activeElement?.id).toBe(ACTIONS_REGION_ID);
      // ...and it did not take the page with it. `instances` pairs with `calls` by index, which is
      // how the call that focused the *region* is told apart from the ones that focused chits.
      const onTheRegion = spy.mock.calls.filter(
        (_call, index) =>
          (spy.mock.instances[index] as HTMLElement | undefined)?.id === ACTIONS_REGION_ID,
      );
      expect(onTheRegion, "the bar never caught the focus at all").toHaveLength(1);
      expect(onTheRegion[0]?.[0]?.preventScroll).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("leaves focus alone when the press did not remove anything", async () => {
    // A command can stay legal — rolling doubles leaves `roll_dice` on the bar — and in that case the
    // player is still standing on the button they pressed. Moving them to the container would be a
    // regression dressed as a fix.
    const { rerender } = render(bar([roll, endTurn]));
    const chit = screen.getByRole("button", { name: /Roll the dice/ });
    chit.focus();
    await userEvent.click(chit);

    rerender(bar([roll, endTurn]));

    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Roll the dice/ }));
  });

  it("never moves focus for a command set that changed on its own", () => {
    // The guard that keeps this from being a focus thief: the repair is armed by an *activation*. A
    // rebuild caused by somebody else’s turn arriving over the socket must not pull this player’s
    // keyboard into the bar.
    const { rerender } = render(bar([roll]));
    expect(document.activeElement).toBe(document.body);

    rerender(bar([endTurn]));

    expect(document.activeElement).toBe(document.body);
  });
});
