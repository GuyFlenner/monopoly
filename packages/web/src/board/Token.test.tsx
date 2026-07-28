import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SEAT_COUNT, TOKEN_IDENTITY, TOKEN_SHAPE_PATH, type SeatNumber } from "@/theme";

import {
  ICON_MIN_PX,
  planCluster,
  Token,
  TokenCluster,
  TOKEN_MIN_PX,
  type TokenOccupant,
} from "./Token";

function occupants(count: number, currentSeat = 1): TokenOccupant[] {
  return Array.from({ length: count }, (_, index) => ({
    seat: (index + 1) as SeatNumber,
    name: `Player ${String(index + 1)}`,
    isCurrent: index + 1 === currentSeat,
  }));
}

describe("planCluster", () => {
  it("draws nobody for an empty square", () => {
    expect(planCluster(0, 60)).toMatchObject({ shown: 0, overflow: 0, columns: 0 });
  });

  it("never overlaps: every piece it draws gets its own cell", () => {
    // The one failure mode this whole ladder exists to prevent. For every crowd and every board
    // width, the grid must have at least as many cells as pieces drawn.
    for (let count = 1; count <= SEAT_COUNT; count += 1) {
      for (const width of [0, 20, 29, 44, 60, 96, 140]) {
        const plan = planCluster(count, width);
        const rows = Math.ceil(plan.shown / Math.max(plan.columns, 1));
        expect(
          plan.columns * rows,
          `${String(count)} on ${String(width)}px`,
        ).toBeGreaterThanOrEqual(plan.shown);
        expect(plan.shown + plan.overflow).toBe(count);
      }
    }
  });

  it("keeps every piece legible or does not draw it", () => {
    for (let count = 1; count <= SEAT_COUNT; count += 1) {
      for (const width of [20, 29, 44, 60, 96, 140]) {
        const plan = planCluster(count, width);
        expect(plan.tokenPx, `${String(count)} on ${String(width)}px`).toBeGreaterThanOrEqual(
          Math.min(TOKEN_MIN_PX, plan.tokenPx),
        );
        if (plan.overflow === 0 && count > 1) {
          expect(plan.tokenPx).toBeGreaterThanOrEqual(TOKEN_MIN_PX);
        }
      }
    }
  });

  it("collapses to a leader and a count when six pieces cannot fit", () => {
    // 29 px is a square on a 320 px board. Six legible pieces do not fit inside it, and the plan
    // says so rather than drawing six smudges on top of each other.
    const tight = planCluster(6, 29);
    expect(tight.shown).toBe(1);
    expect(tight.overflow).toBe(5);
  });

  it("draws all six on a board wide enough for them", () => {
    const roomy = planCluster(6, 96);
    expect(roomy.shown).toBe(6);
    expect(roomy.overflow).toBe(0);
    expect(roomy.columns).toBe(3);
  });

  it("drops the icon channel before it drops a piece", () => {
    // Shape and colour survive to well under 12 px; the rider does not. Losing the icon costs
    // nothing that matters, and it buys room to keep every identity on screen.
    const small = planCluster(4, 44);
    expect(small.shown).toBe(4);
    expect(small.withIcon).toBe(false);
    expect(small.tokenPx).toBeLessThan(ICON_MIN_PX);
    expect(small.tokenPx).toBeGreaterThanOrEqual(TOKEN_MIN_PX);

    const large = planCluster(2, 140);
    expect(large.withIcon).toBe(true);
  });

  it("shows every identity when the board has not been measured yet", () => {
    // jsdom and the first paint both report zero. Collapsing on the strength of a measurement that
    // has not happened would hide players for no reason.
    const plan = planCluster(6, 0);
    expect(plan.shown).toBe(6);
    expect(plan.overflow).toBe(0);
  });
});

describe("Token", () => {
  it("draws the seat's own shape from the theme, not a colour swatch", () => {
    for (const identity of TOKEN_IDENTITY) {
      const { container, unmount } = render(<Token seat={identity.seat} />);
      const paths = [...container.querySelectorAll("path")].map((path) => path.getAttribute("d"));
      expect(paths).toContain(TOKEN_SHAPE_PATH[identity.shape]);
      unmount();
    }
  });

  it("gives six seats six different shapes", () => {
    const shapes = new Set(TOKEN_IDENTITY.map((identity) => TOKEN_SHAPE_PATH[identity.shape]));
    expect(shapes.size).toBe(SEAT_COUNT);
  });

  it("is silent unless it is given a name of its own", () => {
    const { container } = render(<Token seat={1} />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("names itself with the player's name when asked", () => {
    render(<Token seat={3} label="Maya" />);
    expect(screen.getByRole("img", { name: "Maya" })).toBeInTheDocument();
  });

  it("omits the rider when it would be a smudge", () => {
    const withIcon = render(<Token seat={1} withIcon />).container.querySelectorAll("path").length;
    const without = render(<Token seat={1} withIcon={false} />).container.querySelectorAll(
      "path",
    ).length;
    expect(withIcon).toBeGreaterThan(without);
  });
});

describe("TokenCluster", () => {
  it("draws one piece per occupant when they fit", () => {
    const { container } = render(
      <TokenCluster
        occupants={occupants(6)}
        tileInlineSize={96}
        overflowLabel={(n) => `+${String(n)}`}
      />,
    );
    expect(container.querySelectorAll("svg")).toHaveLength(6);
    expect(screen.queryByTestId("token-overflow")).not.toBeInTheDocument();
  });

  it("shows a count instead of stacking pieces when they do not fit", () => {
    render(
      <TokenCluster
        occupants={occupants(6)}
        tileInlineSize={29}
        overflowLabel={(n) => `+${String(n)}`}
      />,
    );
    expect(screen.getByTestId("token-overflow")).toHaveTextContent("+5");
  });

  it("keeps the acting seat's piece when it collapses", () => {
    // Whose turn it is is the one thing a player looks for on a crowded square.
    const { container } = render(
      <TokenCluster
        occupants={occupants(6, 4)}
        tileInlineSize={29}
        overflowLabel={(n) => `+${String(n)}`}
      />,
    );
    const seatFour = TOKEN_IDENTITY[3];
    const drawn = [...container.querySelectorAll("path")].map((path) => path.getAttribute("d"));
    expect(drawn).toContain(TOKEN_SHAPE_PATH[seatFour.shape]);
  });

  it("says nothing: the square that contains it already names its occupants", () => {
    render(
      <TokenCluster occupants={occupants(2)} tileInlineSize={96} overflowLabel={() => "+1"} />,
    );
    expect(screen.getByTestId("token-cluster")).toHaveAttribute("aria-hidden", "true");
  });

  it("draws nothing at all for an empty square", () => {
    const { container } = render(
      <TokenCluster occupants={[]} tileInlineSize={96} overflowLabel={() => ""} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
