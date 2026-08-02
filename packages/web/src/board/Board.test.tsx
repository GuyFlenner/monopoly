import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { patternDomId, SEAT_COUNT, ThemeSprite, TILE_THEME_KEYS } from "@/theme";

import { Board } from "./Board";
import { makeProperties, makeRingBoard, makeRingState, makeSeats } from "./fixtures";
import { TILE_COUNT } from "./geometry";
import { INTERACTIVE_MIN_INLINE_PX } from "./useBoardMetrics";

/**
 * Force the board's measured inline size.
 *
 * jsdom has no layout engine and no `ResizeObserver`, so the component's fallback path — one
 * `getBoundingClientRect()` — is the one under test here, and stubbing the rect is how the two
 * interaction modes become reachable at all. The *geometry* those modes are about is measured for
 * real by MON-707's Playwright run; what these tests own is that the right mode is chosen and that
 * the mode's contract holds.
 */
function withBoardInlineSize(px: number): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: px,
    height: px,
    top: 0,
    left: 0,
    bottom: px,
    right: px,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

/**
 * The cell for a tile *index*.
 *
 * Not `getAllByRole("gridcell")[n]`: the cells are in DOM order, which is row order, so the first
 * one is the top-left corner (square 20) and not GO. Indexing by position would make every keyboard
 * assertion below quietly test the wrong square.
 */
function cellAt(index: number): HTMLElement {
  const cell = document.querySelector<HTMLElement>(`[data-tile-index="${String(index)}"]`);
  if (cell === null) {
    throw new Error(`no cell rendered for tile ${String(index)}`);
  }
  return cell;
}

function activeIndex(): number {
  const active = document.querySelector<HTMLElement>('[data-active="true"]');
  return Number(active?.getAttribute("data-tile-index") ?? "-1");
}

/** A phone. Eleven columns of 44 px need 484, so no square here may be a tap target. */
const NARROW_PX = 320;
/** Comfortably above the breakpoint, where squares may rove and carry a 44 px target. */
const WIDE_PX = 800;

function renderBoard(
  options: { width: number; onOpenTile?: (index: number) => void } = { width: WIDE_PX },
) {
  withBoardInlineSize(options.width);
  const board = makeRingBoard();
  const state = makeRingState();
  const result = render(
    // `<Board>` requires a `<ThemeSprite>` ancestor for the `url(#kesef-band-…)` its colour bands
    // paint with; the app shell mounts the only one (`App.tsx`), and a Board rendered outside the
    // shell supplies its own as a sibling. Satisfying the dependency here rather than inside the
    // component is the difference between one `<defs>` in the document and two.
    <>
      <ThemeSprite />
      <Board
        board={board}
        state={state}
        {...(options.onOpenTile === undefined ? {} : { onOpenTile: options.onOpenTile })}
      />
    </>,
  );
  return { ...result, board, state };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.dir = "ltr";
});

describe("Board layout", () => {
  it("draws every square the board has", () => {
    renderBoard();
    expect(screen.getAllByRole("gridcell")).toHaveLength(TILE_COUNT);
  });

  it("places each square in the row and column the geometry chose", () => {
    renderBoard();
    // GO is the bottom corner at column 11. A mirrored grid or a transposed placement fails here
    // rather than in a screenshot review.
    expect(cellAt(0)).toHaveAttribute("aria-colindex", "11");
    expect(cellAt(0).closest("[role='row']")).toHaveAttribute("aria-rowindex", "11");
    // Square 1 is one step further along the bottom edge: same row, one column back.
    expect(cellAt(1)).toHaveAttribute("aria-colindex", "10");
    // The top corner at column 1 is Free Parking, square 20.
    expect(cellAt(20)).toHaveAttribute("aria-colindex", "1");
    expect(cellAt(20).closest("[role='row']")).toHaveAttribute("aria-rowindex", "1");
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "11");
    expect(screen.getByRole("grid")).toHaveAttribute("aria-colcount", "11");
  });

  it("gives every ownable square a colour band with a pattern, railroads and utilities included", () => {
    // G-A3/G-52: the engine leaves railroads and utilities `group=null`, and identifying six ownable
    // squares by text alone is the same defect as identifying them by colour alone.
    renderBoard();
    const bands = screen.getAllByTestId("group-band");
    const patterns = new Set(bands.map((band) => band.getAttribute("data-pattern")));
    expect(patterns).toContain(patternDomId("railroad"));
    expect(patterns).toContain(patternDomId("utility"));
    for (const key of TILE_THEME_KEYS) {
      expect(patterns, `no band for ${key}`).toContain(patternDomId(key));
    }
  });

  it("gives a square nobody can own no band at all, rather than a fallback colour", () => {
    renderBoard();
    // Four corners plus the taxes, chances and chests. Painting Free Parking brown would be worse
    // than painting it plain, so the count of bands must be strictly below the count of squares.
    expect(screen.getAllByTestId("group-band").length).toBeLessThan(TILE_COUNT);
  });

  /**
   * The other half of the 320 px overflow regression; `board.css.test.ts` owns the sizing half and
   * explains why neither can be a measurement.
   *
   * A square left to grid's auto-placement is a square whose position depends on the *order* the
   * squares are emitted in, and the bottom edge is emitted in travel order — columns 11, 10, ... 2.
   * Sparse auto-placement cannot put an item in a column behind its cursor, so it opened a new
   * implicit row for each of the ten: a 145 px staircase inside a 26 px band, ten squares painting
   * over the panels under the felt. Explicit placement in both axes is what makes emission order
   * irrelevant, and it is checkable without layout because it is an inline style.
   */
  it("places every square explicitly in both axes, so no square is auto-placed", () => {
    renderBoard();
    for (let index = 0; index < TILE_COUNT; index += 1) {
      const cell = cellAt(index).parentElement;
      expect(cell, `square ${String(index)} has no grid area`).not.toBeNull();
      const placed = cell as HTMLElement;
      expect(placed.style.gridColumn, `square ${String(index)} has no explicit column`).not.toBe(
        "",
      );
      expect(placed.style.gridRow, `square ${String(index)} has no explicit row`).toBe("1");
    }
  });

  it("mounts no pattern <defs> of its own, so the ten pattern ids appear once", () => {
    // The sprite in `renderBoard` is the shell's stand-in and the only one there should be. A second
    // copy is invisible — `url(#id)` resolves the first — and is ten duplicated element ids.
    const { container } = renderBoard();
    expect(container.querySelectorAll("defs")).toHaveLength(1);
    for (const key of TILE_THEME_KEYS) {
      expect(
        container.querySelectorAll(`#${patternDomId(key)}`),
        `${patternDomId(key)} is not unique`,
      ).toHaveLength(1);
    }
  });
});

describe("the dir=ltr exception (spec 5.1 as amended, G-44)", () => {
  it("pins the grid to ltr even when the document is rtl", () => {
    document.documentElement.dir = "rtl";
    renderBoard();
    // If this ever reads "rtl" or is absent, tokens circle one way in English and the other way in
    // Hebrew — the direction of travel is a property of the game, not of the reading order.
    expect(screen.getByRole("grid")).toHaveAttribute("dir", "ltr");
  });

  it("lets square text follow the document direction", () => {
    renderBoard();
    const inherited = document.querySelectorAll('[dir="inherit"]');
    // One per square: the grid does not mirror and the words inside it must.
    expect(inherited.length).toBeGreaterThanOrEqual(TILE_COUNT);
  });

  it("pins the grid to ltr in English too, so the attribute is not locale-conditional", () => {
    renderBoard();
    expect(screen.getByRole("grid")).toHaveAttribute("dir", "ltr");
  });
});

describe("keyboard: one composite widget, not forty tab stops (G-E2)", () => {
  it("has exactly one tab stop in the grid, whatever the width", () => {
    for (const width of [NARROW_PX, WIDE_PX]) {
      const { unmount } = renderBoard({ width });
      const grid = screen.getByRole("grid");
      const tabbable = [grid, ...grid.querySelectorAll<HTMLElement>("[tabindex]")].filter(
        (element) => Number(element.getAttribute("tabindex") ?? "-1") >= 0,
      );
      expect(tabbable, `at ${String(width)}px`).toHaveLength(1);
      unmount();
      vi.restoreAllMocks();
    }
  });

  it("puts the skip-to-actions link before the board in the tab order", async () => {
    renderBoard();
    await userEvent.tab();
    expect(screen.getByRole("link", { name: /skip to actions/i })).toHaveFocus();
  });

  it("walks the ring with the arrow keys, clockwise from GO", async () => {
    renderBoard({ width: WIDE_PX });
    cellAt(0).focus();
    // Play runs towards the start of the bottom edge, which is leftward on an unmirrored grid.
    await userEvent.keyboard("{ArrowLeft}");
    expect(activeIndex()).toBe(1);
    await userEvent.keyboard("{ArrowLeft}");
    expect(activeIndex()).toBe(2);
    await userEvent.keyboard("{ArrowRight}");
    expect(activeIndex()).toBe(1);
  });

  it("turns the corner: at GO, up goes back along the trailing edge", async () => {
    renderBoard({ width: WIDE_PX });
    cellAt(0).focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(activeIndex()).toBe(39);
  });

  it("does nothing for an arrow that leaves the ring", async () => {
    renderBoard({ width: WIDE_PX });
    cellAt(0).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(activeIndex()).toBe(0);
  });

  it("sends Home to GO and End to jail, from the board data", async () => {
    const { board } = renderBoard({ width: WIDE_PX });
    cellAt(0).focus();
    await userEvent.keyboard("{End}");
    // From `board.go_to_jail_target`, not a hardcoded 10 — another board may move the jail.
    expect(activeIndex()).toBe(board.go_to_jail_target);
    await userEvent.keyboard("{Home}");
    expect(activeIndex()).toBe(0);
  });

  it("opens a square's detail on Enter", async () => {
    const onOpenTile = vi.fn();
    renderBoard({ width: WIDE_PX, onOpenTile });
    cellAt(0).focus();
    await userEvent.keyboard("{ArrowLeft}{Enter}");
    expect(onOpenTile).toHaveBeenCalledWith(1);
  });

  it("moves the roving tab stop with the cursor, above the breakpoint", async () => {
    renderBoard({ width: WIDE_PX });
    expect(cellAt(0)).toHaveAttribute("tabindex", "0");
    cellAt(0).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(cellAt(0)).toHaveAttribute("tabindex", "-1");
    expect(cellAt(1)).toHaveAttribute("tabindex", "0");
    // The tab stop and the DOM focus move together, or a keyboard user drives an invisible cursor.
    expect(cellAt(1)).toHaveFocus();
  });
});

describe("hit targets at 320 px (G-C1/G-53)", () => {
  it("tests the two widths that actually straddle the breakpoint", () => {
    // Guards the tests below against becoming vacuous: if the breakpoint ever moved past 800 px, or
    // 320 px stopped being narrow, every assertion after this would still pass while testing one
    // mode twice.
    expect(NARROW_PX).toBeLessThan(INTERACTIVE_MIN_INLINE_PX);
    expect(WIDE_PX).toBeGreaterThanOrEqual(INTERACTIVE_MIN_INLINE_PX);
  });

  it("makes no square a tap target on a board too narrow for the 44 px floor", () => {
    renderBoard({ width: NARROW_PX });
    expect(screen.getByRole("grid")).toHaveAttribute("data-interactive", "false");
    for (const cell of screen.getAllByRole("gridcell")) {
      expect(cell).toHaveAttribute("tabindex", "-1");
      // No `.target` either: a 29 px square claiming a 44 px minimum would either lie or overflow
      // the grid and give the page a horizontal scrollbar.
      expect(cell.className).not.toMatch(/\btarget\b/);
    }
  });

  it("points at the active square with aria-activedescendant when no square may be focused", () => {
    renderBoard({ width: NARROW_PX });
    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("tabindex", "0");
    const active = grid.getAttribute("aria-activedescendant");
    expect(active).not.toBeNull();
    expect(document.getElementById(active ?? "")).toHaveAttribute("data-active", "true");
  });

  it("still navigates the whole ring by keyboard on a phone", async () => {
    renderBoard({ width: NARROW_PX });
    const grid = screen.getByRole("grid");
    grid.focus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("grid").getAttribute("aria-activedescendant")).toBe("kesef-tile-2");
  });

  it("offers a real button, not a hover or a long-press, to open a square on a phone", async () => {
    const onOpenTile = vi.fn();
    renderBoard({ width: NARROW_PX, onOpenTile });
    const open = screen.getByRole("button", { name: /open/i });
    expect(open.className).toMatch(/\btarget\b/);
    await userEvent.click(open);
    expect(onOpenTile).toHaveBeenCalledWith(0);
  });

  it("lets squares be tap targets once the board is wide enough", async () => {
    const onOpenTile = vi.fn();
    renderBoard({ width: WIDE_PX, onOpenTile });
    expect(screen.getByRole("grid")).toHaveAttribute("data-interactive", "true");
    for (const cell of screen.getAllByRole("gridcell")) {
      expect(cell.className).toMatch(/\btarget\b/);
    }
    await userEvent.click(cellAt(7));
    expect(onOpenTile).toHaveBeenCalledWith(7);
  });

  it("ignores a click on a square that is not allowed to be a target", async () => {
    const onOpenTile = vi.fn();
    renderBoard({ width: NARROW_PX, onOpenTile });
    await userEvent.click(cellAt(3));
    expect(onOpenTile).not.toHaveBeenCalled();
  });

  it("gives every tabbable element in the subtree the 44 px target class", () => {
    // jsdom has no layout, so this asserts the *contract* — the `.target` utility, which
    // `index.css` defines as `min-block-size` and `min-inline-size` of 44 px — rather than a
    // measured rect. MON-707's Playwright run does the real geometric check at 320 px.
    for (const width of [NARROW_PX, WIDE_PX]) {
      const { container, unmount } = renderBoard({ width });
      const tabbable = [...container.querySelectorAll<HTMLElement>("a[href], button, [tabindex]")]
        .filter((element) => {
          const raw = element.getAttribute("tabindex");
          return raw === null ? true : Number(raw) >= 0;
        })
        // The skip link is `sr-only` until focused; it carries `target` for when it is not.
        .filter((element) => !element.hasAttribute("disabled"));
      expect(tabbable.length, `at ${String(width)}px`).toBeGreaterThan(0);
      for (const element of tabbable) {
        expect(element.className, `${element.tagName} at ${String(width)}px`).toMatch(/\btarget\b/);
      }
      unmount();
      vi.restoreAllMocks();
    }
  });
});

describe("what the board draws is what the projection said", () => {
  it("marks the owner with the owner's own seat colour", () => {
    withBoardInlineSize(WIDE_PX);
    render(
      <Board
        board={makeRingBoard()}
        state={makeRingState({
          players: makeSeats(["Ruti", "Dan"]),
          properties: makeProperties({ 1: { owner: 1 } }),
        })}
      />,
    );
    const markers = screen.getAllByTestId("ownership-marker");
    expect(markers).toHaveLength(1);
    // Player id 1 is the *second* seat, so the marker must say seat 2 — an off-by-one here would
    // paint every street in the wrong player's colour.
    expect(markers[0]).toHaveAttribute("data-owner-seat", "2");
  });

  it("draws one figure per house, and the fifth building as a single hotel (MON-710)", () => {
    withBoardInlineSize(WIDE_PX);
    render(
      <Board
        board={makeRingBoard()}
        state={makeRingState({
          properties: makeProperties({
            1: { owner: 0, houses: 3 },
            3: { owner: 0, houses: 5 },
          }),
        })}
      />,
    );
    const [threeHouses, hotel] = screen.getAllByTestId("development");

    // Three cottages, not one mark meaning three: a child counts the buildings on the square.
    const houses = within(threeHouses as HTMLElement).getAllByTestId("building-figure");
    expect(houses).toHaveLength(3);
    expect(houses.map((figure) => figure.getAttribute("data-level"))).toEqual([
      "house",
      "house",
      "house",
    ]);
    // And the fifth building replaces them rather than joining them.
    const built = within(hotel as HTMLElement).getAllByTestId("building-figure");
    expect(built).toHaveLength(1);
    expect(built[0]).toHaveAttribute("data-level", "hotel");

    // The 1 px gap is one of the four terms in the "four houses fit at 320 px" arithmetic that
    // `board.css.test.ts` does; this is where that term is actually declared.
    expect((threeHouses as HTMLElement).className).toContain("gap-px");
  });

  it("says nothing about the buildings out loud — the square's name already does", () => {
    // Four decorative shapes read in place of "with three houses" is worse than silence; the words
    // come from `describeTile`, and `buildings.tsx` is `aria-hidden` by construction.
    withBoardInlineSize(WIDE_PX);
    render(
      <Board
        board={makeRingBoard()}
        state={makeRingState({ properties: makeProperties({ 1: { owner: 0, houses: 3 } }) })}
      />,
    );
    expect(screen.getByTestId("development")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getAllByTestId("building-figure")[0]).toHaveAttribute("aria-hidden", "true");
  });

  it("draws houses as pips and the fifth building as a hotel", () => {
    withBoardInlineSize(WIDE_PX);
    render(
      <Board
        board={makeRingBoard()}
        state={makeRingState({
          properties: makeProperties({
            1: { owner: 0, houses: 3 },
            3: { owner: 0, houses: 5 },
          }),
        })}
      />,
    );
    const developments = screen.getAllByTestId("development");
    expect(developments).toHaveLength(2);
    expect(developments[0]).toHaveAttribute("data-houses", "3");
    expect(developments[0]).toHaveAttribute("data-hotel", "false");
    expect(developments[1]).toHaveAttribute("data-hotel", "true");
  });

  it("flags a mortgage, and only where the projection says so", () => {
    withBoardInlineSize(WIDE_PX);
    render(
      <Board
        board={makeRingBoard()}
        state={makeRingState({ properties: makeProperties({ 6: { owner: 0, mortgaged: true } }) })}
      />,
    );
    expect(screen.getAllByTestId("mortgaged")).toHaveLength(1);
  });

  it("draws no marker for a square the bank still holds", () => {
    renderBoard();
    expect(screen.queryAllByTestId("ownership-marker")).toHaveLength(0);
    expect(screen.queryAllByTestId("development")).toHaveLength(0);
    expect(screen.queryAllByTestId("mortgaged")).toHaveLength(0);
  });

  it("names every fact about a square in its accessible name", () => {
    withBoardInlineSize(WIDE_PX);
    render(
      <Board
        board={makeRingBoard()}
        state={makeRingState({
          players: makeSeats(["Ruti", "Dan"]),
          properties: makeProperties({ 1: { owner: 0, houses: 5, mortgaged: false } }),
        })}
      />,
    );
    const name = cellAt(1).getAttribute("aria-label") ?? "";
    expect(name).toContain("Mediterranean Avenue");
    expect(name).toContain("Ruti");
    expect(name).toContain("hotel");
  });
});

describe("tokens on the board", () => {
  it("puts every seat's piece on the square the projection says it is on", () => {
    withBoardInlineSize(WIDE_PX);
    const players = makeSeats(["Ruti", "Dan", "Maya"]);
    render(
      <Board
        board={makeRingBoard()}
        state={makeRingState({
          players: players.map((player, index) => ({ ...player, position: index * 3 })),
        })}
      />,
    );
    expect(screen.getAllByTestId("token-cluster")).toHaveLength(3);
  });

  it("does not overlap six pieces on one square", () => {
    withBoardInlineSize(WIDE_PX);
    const players = makeSeats(["a", "b", "c", "d", "e", "f"]);
    render(<Board board={makeRingBoard()} state={makeRingState({ players })} />);
    const clusters = screen.getAllByTestId("token-cluster");
    expect(clusters).toHaveLength(1);
    const cluster = clusters[0];
    if (cluster === undefined) {
      return;
    }
    const drawn = cluster.querySelectorAll("svg").length;
    const overflow = Number(cluster.getAttribute("data-overflow") ?? "0");
    // Every seat is accounted for, either as a piece or in the count. None is hidden underneath.
    expect(drawn + overflow).toBe(SEAT_COUNT);
  });

  it("keeps a bankrupt seat's piece off the board", () => {
    withBoardInlineSize(WIDE_PX);
    const players = makeSeats(["Ruti", "Dan"]);
    render(
      <Board
        board={makeRingBoard()}
        state={makeRingState({
          players: players.map((player, index) => ({
            ...player,
            position: index * 5,
            bankrupt: index === 1,
          })),
        })}
      />,
    );
    expect(screen.getAllByTestId("token-cluster")).toHaveLength(1);
  });

  it("names the occupants on the square rather than on each piece", () => {
    withBoardInlineSize(WIDE_PX);
    render(
      <Board
        board={makeRingBoard()}
        state={makeRingState({ players: makeSeats(["Ruti", "Dan"]) })}
      />,
    );
    const cell = cellAt(0);
    expect(cell.getAttribute("aria-label")).toContain("Ruti");
    expect(cell.getAttribute("aria-label")).toContain("Dan");
    expect(within(cell).getByTestId("token-cluster")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("narration belongs to the Announcer, not to the board (G-D1/G-54)", () => {
  it("renders no aria-live region anywhere in its subtree", () => {
    const { container } = renderBoard();
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(
      container.querySelectorAll("[role='status'], [role='alert'], [role='log']"),
    ).toHaveLength(0);
  });
});
