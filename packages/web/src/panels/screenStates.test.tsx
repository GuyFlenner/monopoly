/**
 * The MON-708 inventory, asserted (MON-708).
 *
 * The acceptance criterion is "every screen/panel gets a deliberate empty, loading and error state:
 * no blank whites, no spinners-forever, no untranslated errors". The empty and error states of the
 * *screens* live in `App.test.tsx`; this file is the sweep over the panels, and it exists for one
 * reason: an inventory written in a commit message is an inventory that rots. Here, a panel that
 * loses its empty state fails a test.
 *
 * ## What is checked, and what is deliberately not
 *
 * Each panel is rendered in its empty condition, and asserted to say something from the catalogue —
 * not merely to render. `data-state="empty"` is the shared marker every one of them now carries, so
 * the assertion is "this is a deliberate empty state" rather than "some text happens to be here".
 *
 * Loading and error states are **not** invented for panels that have no asynchronous work of their
 * own. `<EventLog>`, `<PlayerDossier>`, `<ActionBar>` and `<Board>` are handed data by the screen; a
 * spinner inside them would be a spinner that could never appear, and the wait that does exist is
 * the game screen's — asserted in `App.test.tsx`. The two panels that *do* have their own async
 * work, `<TradeBuilder>` (the validator) and `<LoadSavedGame>` (the upload), have all three, and
 * both are covered in their own files.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AnnouncerProvider } from "@/a11y";
import type { BoardView, GameStateView, PlayerView } from "@/api";
import { Board } from "@/board";
import { makeRingBoard, makeRingState } from "@/board/fixtures";
import { expectAxeClean } from "@/test/axe";
import { makeBoard, makePlayer, makeTile } from "@/test/fixtures";

import { ActionBar } from "./ActionBar";
import { AuctionPanel, type AuctionFrameView } from "./AuctionPanel";
import { EventLog } from "./EventLog";
import { PlayerDossier } from "./PlayerDossier";

const PLAYERS: readonly PlayerView[] = [
  makePlayer(0, { name: "Ruti" }),
  makePlayer(1, { name: "Dan" }),
];

/**
 * Two squares, the second with a name the `board-classic` catalogue actually has.
 *
 * `makeTile`'s default `tile.classic.t1` is not in any catalogue, and the auction panel names its lot
 * — so a default fixture makes `missingKeyHandler` throw. That is the guard working, not a nuisance.
 */
const BOARD: BoardView = makeBoard({
  tiles: [
    makeTile(0, { kind: "go", group: null, is_ownable: false }),
    makeTile(1, { name_key: "tile.classic.mediterranean_avenue" }),
  ],
});

/** The shared marker, so a test asserts "a deliberate empty state" and not "some text". */
function emptyStates(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-state="empty"]')];
}

describe("the event log's empty state", () => {
  it("says why it is empty rather than showing an empty box", () => {
    const { container } = render(<EventLog events={[]} players={PLAYERS} board={BOARD} />);

    expect(emptyStates(container)).toHaveLength(1);
    expect(screen.getByText("Nothing yet. Roll the dice to start the story.")).toBeInTheDocument();
  });

  it("is axe clean while empty", async () => {
    const { container } = render(<EventLog events={[]} players={PLAYERS} board={BOARD} />);
    await expectAxeClean(container);
  });
});

describe("the action bar's empty state", () => {
  it("says there is nothing to do rather than rendering a bare heading", () => {
    // Reachable constantly: it is every moment the engine offers no commands to this seat — while a
    // bot is thinking, or between an interrupt resolving and the next phase.
    const { container } = render(
      <AnnouncerProvider>
        <ActionBar commands={[]} onCommand={() => undefined} board={BOARD} jailFine={50} />
      </AnnouncerProvider>,
    );

    expect(emptyStates(container)).toHaveLength(1);
    expect(screen.getByText("No moves right now.")).toBeInTheDocument();
  });

  it("is axe clean while empty", async () => {
    const { container } = render(
      <AnnouncerProvider>
        <ActionBar commands={[]} onCommand={() => undefined} board={BOARD} jailFine={50} />
      </AnnouncerProvider>,
    );
    await expectAxeClean(container);
  });
});

describe("the dossier's empty state", () => {
  it("says a seat owns nothing, which is every seat on turn one", () => {
    const { container } = render(
      <PlayerDossier
        player={makePlayer(0, { name: "Ruti", tiles_owned: [] })}
        players={PLAYERS}
        board={BOARD}
        properties={[]}
        isCurrent
      />,
    );

    expect(emptyStates(container)).toHaveLength(1);
    expect(screen.getByText("No properties yet")).toBeInTheDocument();
  });
});

describe("the auction panel's empty state", () => {
  function frame(overrides: Partial<AuctionFrameView> = {}): AuctionFrameView {
    return {
      kind: "auction",
      resume: "awaiting_roll",
      lot: { kind: "tile", tile: 1 },
      reason: "declined_purchase",
      eligible: [],
      active: [],
      turn: null,
      high_bid: 0,
      high_bidder: null,
      min_bid: 1,
      max_bid: 100,
      queue: [],
      withdrawn: [],
      ...overrides,
    };
  }

  it("says so when nobody is eligible, instead of an empty felt rectangle", () => {
    // A real frame the engine can produce — every seat bankrupt but the one that owns the lot. Before
    // MON-708 it rendered as a green rectangle under a "Bidders" heading, which reads as a panel that
    // failed to load.
    const { container } = render(
      <AnnouncerProvider>
        <AuctionPanel
          frame={frame()}
          players={PLAYERS}
          board={BOARD}
          legalCommands={[]}
          onSend={() => undefined}
        />
      </AnnouncerProvider>,
    );

    expect(emptyStates(container)).toHaveLength(1);
    expect(screen.getByText("Nobody at the table can bid on this one.")).toBeInTheDocument();
  });

  it("shows no such state when there are bidders", () => {
    // The falsifier for the test above: a component that rendered the sentence unconditionally would
    // pass that one and fail this. An empty state that is always on is not an empty state.
    const { container } = render(
      <AnnouncerProvider>
        <AuctionPanel
          frame={frame({ eligible: [0, 1], active: [0, 1], turn: 0 })}
          players={PLAYERS}
          board={BOARD}
          legalCommands={[]}
          onSend={() => undefined}
        />
      </AnnouncerProvider>,
    );

    expect(emptyStates(container)).toHaveLength(0);
  });
});

describe("the board's empty state", () => {
  /** A `BoardView` with no squares — reachable through a save file, whose `board_id` is a player's. */
  const NO_SQUARES: BoardView = makeRingBoard({ tiles: [] });
  const STATE: GameStateView = makeRingState();

  it("says so rather than painting felt with nothing on it", () => {
    const { container } = render(
      <AnnouncerProvider>
        <Board board={NO_SQUARES} state={STATE} actionsRegionId="actions" />
      </AnnouncerProvider>,
    );

    expect(emptyStates(container)).toHaveLength(1);
    expect(screen.getByText("This board has no squares to show.")).toBeInTheDocument();
    // And no grid, because a `role="grid"` with no cells in it is a worse answer than a sentence.
    expect(screen.queryByTestId("board-grid")).toBeNull();
  });

  it("still renders the interior well, so the turn summary stays usable", () => {
    // The screen puts the turn summary and the dice tray in `children`. Dropping them would turn one
    // bad board into a screen with nothing on it at all.
    render(
      <AnnouncerProvider>
        <Board board={NO_SQUARES} state={STATE} actionsRegionId="actions">
          <p>Turn 1</p>
        </Board>
      </AnnouncerProvider>,
    );

    expect(screen.getByText("Turn 1")).toBeInTheDocument();
  });

  it("draws the grid as usual when the board has squares", () => {
    // The falsifier: `tiles.length === 0` and not something that fires on a real board.
    render(
      <AnnouncerProvider>
        <Board board={makeRingBoard()} state={STATE} actionsRegionId="actions" />
      </AnnouncerProvider>,
    );

    expect(screen.getByTestId("board-grid")).toBeInTheDocument();
    expect(screen.queryByText("This board has no squares to show.")).toBeNull();
  });

  it("is axe clean while empty", async () => {
    const { container } = render(
      <AnnouncerProvider>
        <Board board={NO_SQUARES} state={STATE} actionsRegionId="actions" />
      </AnnouncerProvider>,
    );
    await expectAxeClean(container);
  });
});
