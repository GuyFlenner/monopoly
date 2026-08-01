/**
 * The narrated board: what it draws, and — more importantly — what it refuses to draw.
 *
 * Every assertion here is the same shape: a fact an event stated appears, and a fact no event stated
 * is *absent* rather than defaulted. That pairing is the test. A board that filled in "everyone
 * starts on GO with 1500" would look right for the first frame of every game anybody demonstrated,
 * and would be lying on every frame of a replay opened at turn forty.
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeRingBoard, makeSeats } from "@/board/fixtures";
import { expectAxeClean } from "@/test/axe";
import { ThemeSprite } from "@/theme";

import { ReplayBoard } from "./ReplayBoard";
import { factsAt, NOTHING_STATED, type ReplayFacts } from "./replayFacts";
import { loggedEvent } from "@/test/fixtures";

const BOARD = makeRingBoard();
const PLAYERS = makeSeats(["Ruti", "Dan"]);

function mount(facts: ReplayFacts): HTMLElement {
  const { container } = render(
    <>
      {/* The band patterns live in the app shell's one sprite. */}
      <ThemeSprite />
      <ReplayBoard board={BOARD} players={PLAYERS} facts={facts} />
    </>,
  );
  return container;
}

function cell(index: number): HTMLElement {
  const found = document.querySelector<HTMLElement>(`#kesef-replay-tile-${String(index)}`);
  if (found === null) {
    throw new Error(`no replay cell for square ${String(index)}`);
  }
  return found;
}

/** Facts folded from a hand-written log, so each test says which events it is relying on. */
function facts(...events: readonly Parameters<typeof loggedEvent>[1][]): ReplayFacts {
  return factsAt(
    events.map((event, index) => loggedEvent(index + 1, event)),
    events.length,
  );
}

describe("the ring", () => {
  it("draws every square of the board it was given", () => {
    mount(NOTHING_STATED);
    expect(screen.getAllByRole("gridcell")).toHaveLength(BOARD.tiles.length);
  });

  it("keeps its own id space, so it can sit over the live board", () => {
    // Two elements with one id is invalid HTML and an axe violation, and the live board is still
    // mounted behind this panel with `kesef-tile-…` ids of its own.
    mount(NOTHING_STATED);
    expect(document.querySelectorAll('[id^="kesef-replay-tile-"]')).toHaveLength(
      BOARD.tiles.length,
    );
    expect(document.querySelectorAll('[id^="kesef-tile-"]')).toHaveLength(0);
  });

  it("offers no square as a target, because a record is read and not played", () => {
    mount(NOTHING_STATED);
    for (const gridcell of screen.getAllByRole("gridcell")) {
      expect(gridcell).toHaveAttribute("tabindex", "-1");
    }
  });
});

describe("with nothing stated", () => {
  it("shows an empty ring: no tokens, no owners, no buildings", () => {
    const container = mount(NOTHING_STATED);
    expect(container.querySelectorAll('[data-testid="token-cluster"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="ownership-marker"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="development"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="mortgaged"]')).toHaveLength(0);
  });
});

describe("the facts it copies", () => {
  it("puts a token where a token_moved put it, and nowhere else", () => {
    mount(
      facts({
        type: "token_moved",
        player: 0,
        from_tile: 0,
        to_tile: 12,
        forward: true,
        passed_go: false,
      }),
    );
    expect(within(cell(12)).getByTestId("token-cluster")).toBeInTheDocument();
    // Dan has no stated position, so Dan has no piece on the board — not a piece on GO.
    expect(document.querySelectorAll('[data-testid="token-cluster"]')).toHaveLength(1);
  });

  it("marks the owner a transfer named", () => {
    mount(facts({ type: "property_acquired", player: 1, tile: 6, price: 100, via: "purchase" }));
    const marker = within(cell(6)).getByTestId("ownership-marker");
    // Seat 2 is Dan: seat order, which is what `TOKEN_IDENTITY` is indexed by.
    expect(marker).toHaveAttribute("data-owner-seat", "2");
    expect(within(cell(5)).queryByTestId("ownership-marker")).toBeNull();
  });

  it("draws the buildings a building_changed counted, and reads a hotel off the count", () => {
    mount(
      facts(
        { type: "building_changed", tile: 6, houses: 3, delta: 3, level: "house" },
        { type: "building_changed", tile: 8, houses: 5, delta: 1, level: "hotel" },
      ),
    );
    expect(within(cell(6)).getByTestId("development")).toHaveAttribute("data-houses", "3");
    expect(within(cell(8)).getByTestId("development")).toHaveAttribute("data-hotel", "true");
  });

  it("stamps a mortgage where one was recorded", () => {
    mount(facts({ type: "mortgage_changed", player: 0, tile: 6, mortgaged: true }));
    expect(within(cell(6)).getByTestId("mortgaged")).toBeInTheDocument();
  });

  it("takes a bankrupt seat's piece off the board", () => {
    // The projection's `bankrupt` flag being *read*, exactly as `Board.tsx` reads it — not an
    // inference about what bankruptcy means.
    mount(
      facts(
        {
          type: "token_moved",
          player: 0,
          from_tile: 0,
          to_tile: 12,
          forward: true,
          passed_go: false,
        },
        {
          type: "player_bankrupted",
          player: 0,
          creditor: "bank",
          tiles_transferred: [],
          cash_transferred: 0,
          jail_cards_transferred: [],
          shares: [],
        },
      ),
    );
    expect(document.querySelectorAll('[data-testid="token-cluster"]')).toHaveLength(0);
  });
});

describe("what a screen reader is told", () => {
  it("names the square, its owner and whoever is standing there", () => {
    mount(
      facts(
        { type: "property_acquired", player: 0, tile: 9, price: 100, via: "purchase" },
        {
          type: "token_moved",
          player: 1,
          from_tile: 0,
          to_tile: 9,
          forward: true,
          passed_go: false,
        },
      ),
    );
    const label = cell(9).getAttribute("aria-label") ?? "";
    expect(label).toContain("Connecticut Avenue");
    // `describeTile`, the same sentence builder the live board uses.
    expect(label).toContain("Ruti");
    expect(label).toContain("Dan");
  });

  it("is axe clean", async () => {
    const container = mount(
      facts({ type: "property_acquired", player: 0, tile: 9, price: 100, via: "purchase" }),
    );
    await expectAxeClean(container);
  });
});
