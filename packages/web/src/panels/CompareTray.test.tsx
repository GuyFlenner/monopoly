/**
 * The compare tray: pinning, the ceiling, mirroring, and the thing that must not be a fork.
 *
 * ## The falsifier
 *
 * MON-702's central risk is not a broken tray — it is a *second dossier*. A copy that renders four
 * figures and a deed list looks right in every screenshot and drifts on the first change, and the
 * figure that drifts is net worth, which is precisely the number two players are comparing. So the
 * test below feeds a pinned seat a `net_worth` that **no sum of its cash and its squares' prices**
 * could produce and asserts the tray shows that figure. Reimplement the card here — or compute the
 * total instead of reading `PlayerView.net_worth` — and it goes red.
 *
 * The ceiling is tested the same way round: at three pinned seats a fourth press must change
 * nothing *and* say why, so an implementation that silently ignored the press fails on the
 * announcement and one that pinned a fourth fails on the count.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { AnnouncerProvider, type AnnouncementDraft } from "@/a11y";
import { AnnouncerContext, type AnnouncerContextValue } from "@/a11y/AnnouncerContext";
import type { PlayerView } from "@/api";
import { MAX_PINNED_PLAYERS, useUiStore } from "@/game";
import { applyLocale } from "@/i18n";
import { expectAxeClean } from "@/test/axe";
import { makeBoard, makePlayer, makeTile } from "@/test/fixtures";

import { CompareTray, PinToggle } from "./CompareTray";

const BOARD = makeBoard({
  tiles: [
    makeTile(1, { name_key: "tile.classic.mediterranean_avenue", group: "brown" }),
    makeTile(3, { name_key: "tile.classic.baltic_avenue", group: "brown" }),
  ],
});

const SEATS: readonly PlayerView[] = [
  makePlayer(0, { name: "Ruti", cash: 1500 }),
  makePlayer(1, { name: "Dan", cash: 1200 }),
  makePlayer(2, { name: "Noa", cash: 900 }),
  makePlayer(3, { name: "Ari", cash: 700 }),
];

/** Announcements the tray pushed, so the polite narration can be asserted without a live region. */
let said: readonly AnnouncementDraft[] = [];

function Harness({
  players = SEATS,
  currentPlayerId = 0,
}: {
  readonly players?: readonly PlayerView[];
  readonly currentPlayerId?: number;
}): React.JSX.Element {
  return (
    <AnnouncerContext.Provider
      value={{
        bus: { subscribe: () => () => undefined } as unknown as AnnouncerContextValue["bus"],
        announce: (drafts) => {
          // `announce` takes one draft or several; `"length" in` is the narrowing that keeps both
          // branches typed, where `Array.isArray` widens a readonly array to `any[]`.
          const list: readonly AnnouncementDraft[] = "length" in drafts ? drafts : [drafts];
          said = [...said, ...list];
        },
      }}
    >
      <div>
        {players.map((player) => (
          <div key={player.id} data-testid={`seat-${String(player.id)}`}>
            <span>{player.name}</span>
            <PinToggle playerId={player.id} name={player.name} />
          </div>
        ))}
        <CompareTray
          players={players}
          board={BOARD}
          properties={[]}
          currentPlayerId={currentPlayerId}
        />
      </div>
    </AnnouncerContext.Provider>
  );
}

/**
 * The seat list's own toggle, scoped deliberately.
 *
 * Once a seat is pinned there are **two** toggles for it — one in the seat list and one on its card
 * in the tray — because it is one component serving both surfaces. That is the design, so every
 * query here says which surface it means rather than relying on there being only one.
 */
function pin(playerId: number): HTMLElement {
  return within(screen.getByTestId(`seat-${String(playerId)}`)).getByTestId(
    `pin-player-${String(playerId)}`,
  );
}

function tray(): HTMLElement | null {
  return screen.queryByTestId("compare-tray");
}

beforeEach(() => {
  said = [];
  // The store is module-level by design — two pin buttons must not disagree — so each test starts
  // it empty rather than inheriting the last one's pins.
  useUiStore.setState({ pinnedPlayers: [] });
  applyLocale("en");
});

describe("pinning", () => {
  it("draws nothing at all until something is pinned", () => {
    render(<Harness />);
    // Not an empty state: the tray is a surface that *appears* because a player pinned something, so
    // a permanent empty rail would be chrome explaining a feature nobody asked for.
    expect(tray()).toBeNull();
  });

  it("puts a pinned seat's dossier in the tray", async () => {
    render(<Harness />);
    await userEvent.click(pin(1));

    const rail = screen.getByTestId("compare-tray");
    expect(within(rail).getAllByTestId("player-dossier")).toHaveLength(1);
    expect(within(rail).getByRole("heading", { name: "Dan" })).toBeInTheDocument();
  });

  it("holds three side by side, in the order they were pinned", async () => {
    render(<Harness />);
    await userEvent.click(pin(2));
    await userEvent.click(pin(0));

    const cards = within(screen.getByTestId("compare-tray")).getAllByTestId("player-dossier");
    // Pin order, not seat order: re-sorting under someone who has just pinned a card is how a
    // comparison loses its place.
    expect(cards.map((card) => card.getAttribute("data-player"))).toEqual(["2", "0"]);
  });

  it("unpins from the tray, and the tray disappears with the last card", async () => {
    render(<Harness />);
    await userEvent.click(pin(1));

    const rail = screen.getByTestId("compare-tray");
    await userEvent.click(within(rail).getByTestId("pin-player-1"));

    expect(tray()).toBeNull();
  });

  it("says what happened, politely, through the root announcer", async () => {
    render(<Harness />);
    await userEvent.click(pin(1));
    expect(said).toEqual([{ politeness: "polite", key: "a11y.pinned", params: { name: "Dan" } }]);

    said = [];
    await userEvent.click(pin(1));
    expect(said).toEqual([{ politeness: "polite", key: "a11y.unpinned", params: { name: "Dan" } }]);
  });

  it("renders no live region of its own", async () => {
    const { container } = render(<Harness />);
    await userEvent.click(pin(1));
    // The one `<Announcer>` at the root owns both regions (GAP G-D1/G-54).
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
  });
});

describe("the ceiling of three", () => {
  it("refuses a fourth and says why, rather than silently doing nothing", async () => {
    render(<Harness />);
    await userEvent.click(pin(0));
    await userEvent.click(pin(1));
    await userEvent.click(pin(2));
    said = [];

    await userEvent.click(pin(3));

    expect(
      within(screen.getByTestId("compare-tray")).getAllByTestId("player-dossier"),
    ).toHaveLength(MAX_PINNED_PLAYERS);
    expect(said).toEqual([
      { politeness: "polite", key: "dossier.pin_limit", params: { max: MAX_PINNED_PLAYERS } },
    ]);
  });

  it("marks the unavailable button `aria-disabled` and leaves it focusable", async () => {
    render(<Harness />);
    await userEvent.click(pin(0));
    await userEvent.click(pin(1));
    await userEvent.click(pin(2));

    // `aria-disabled`, not `disabled`: a control a keyboard user cannot reach is a control whose
    // reason they never hear.
    expect(pin(3)).toHaveAttribute("aria-disabled", "true");
    expect(pin(3)).not.toBeDisabled();
    pin(3).focus();
    expect(pin(3)).toHaveFocus();
  });

  it("still lets an already-pinned seat be unpinned at the ceiling", async () => {
    render(<Harness />);
    await userEvent.click(pin(0));
    await userEvent.click(pin(1));
    await userEvent.click(pin(2));

    expect(pin(1)).toHaveAttribute("aria-disabled", "false");
    await userEvent.click(pin(1));
    expect(
      within(screen.getByTestId("compare-tray")).getAllByTestId("player-dossier"),
    ).toHaveLength(2);
  });

  it("drops a pin whose seat is no longer at the table", async () => {
    const { rerender } = render(<Harness />);
    await userEvent.click(pin(3));
    expect(tray()).not.toBeNull();

    // A save file loaded into a game with fewer seats, or a pin held across "New game".
    rerender(<Harness players={SEATS.slice(0, 2)} />);
    expect(tray()).toBeNull();
  });
});

describe("it is the dossier, not a copy of it", () => {
  it("shows the projection's own net worth, which no arithmetic here could have produced", async () => {
    // 4242 agrees with nothing: not the cash, not the cash plus the squares' prices, not any sum.
    // A tray that reimplemented the card would show a number it worked out, and this goes red.
    const players = [makePlayer(0, { name: "Ruti", cash: 1500, net_worth: 4242 })];
    render(<Harness players={players} currentPlayerId={0} />);
    await userEvent.click(pin(0));

    const rail = screen.getByTestId("compare-tray");
    expect(within(rail).getByTestId("dossier-net-worth")).toHaveTextContent("$4,242");
    expect(within(rail).getByTestId("dossier-cash")).toHaveTextContent("$1,500");
  });

  it("marks the tray's cards compact and leaves the aside's alone", async () => {
    render(<Harness />);
    await userEvent.click(pin(1));

    const rail = screen.getByTestId("compare-tray");
    expect(within(rail).getByTestId("player-dossier")).toHaveAttribute("data-compact", "true");
  });

  it("keeps the acting seat marked inside the tray", async () => {
    render(<Harness currentPlayerId={1} />);
    await userEvent.click(pin(1));

    const rail = screen.getByTestId("compare-tray");
    expect(within(rail).getByTestId("player-dossier")).toHaveAttribute("data-current", "true");
  });
});

describe("the scroll and the mirroring", () => {
  it("puts the horizontal scroll on the tray's own rail, never the page", async () => {
    render(<Harness />);
    await userEvent.click(pin(0));

    const rail = screen.getByTestId("compare-tray-rail");
    // jsdom has no layout engine, so this is a check on the *cause*: the class that makes the rail
    // the scroll container. The geometric claim belongs to `e2e/compare.spec.ts`.
    expect(rail.className).toContain("overflow-x-auto");
    expect(document.body.className).not.toContain("overflow-x");
  });

  it("names no physical direction anywhere in the rail's classes", async () => {
    render(<Harness />);
    await userEvent.click(pin(0));

    // The ESLint rule already refuses these in source; this asserts the *rendered* result, which is
    // what a `${}` built at runtime could still smuggle through.
    const rail = screen.getByTestId("compare-tray-rail");
    for (const node of [rail, ...rail.querySelectorAll("*")]) {
      // `getAttribute`, not `.className`: an SVG element's `className` is an `SVGAnimatedString`, and
      // the deed spines inside every card are SVG.
      expect(node.getAttribute("class") ?? "").not.toMatch(
        /\b-?(?:ml|mr|pl|pr|left|right|translate-x|space-x)-/,
      );
    }
  });

  it("renders the same tray under dir=rtl, with no direction of its own", async () => {
    applyLocale("he");
    render(<Harness />);
    await userEvent.click(pin(0));
    await userEvent.click(pin(1));

    const rail = screen.getByTestId("compare-tray-rail");
    // Nothing in the tray pins a direction: it inherits the document's, which is how one rail fills
    // from the right in Hebrew and from the left in English. The *geometry* of that is asserted in
    // Playwright, where there is an engine to measure.
    expect(rail.getAttribute("dir")).toBeNull();
    expect(document.documentElement).toHaveAttribute("dir", "rtl");
    expect(within(rail).getAllByTestId("player-dossier")).toHaveLength(2);
  });

  it("keeps the rail reachable by keyboard, because it scrolls", async () => {
    render(<Harness />);
    await userEvent.click(pin(0));
    // axe's `scrollable-region-focusable`: a scroll container nobody can focus is content nobody can
    // reach without a mouse.
    expect(screen.getByTestId("compare-tray-rail")).toHaveAttribute("tabindex", "0");
  });
});

describe("axe", () => {
  it("is clean with three seats pinned", async () => {
    const { container } = render(
      <AnnouncerProvider>
        <Harness />
      </AnnouncerProvider>,
    );
    await userEvent.click(pin(0));
    await userEvent.click(pin(1));
    await userEvent.click(pin(2));

    await expectAxeClean(container);
  });
});
