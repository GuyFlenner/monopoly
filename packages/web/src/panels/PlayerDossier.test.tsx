/**
 * What must be true of the dossier — and the one test that has to be able to fail.
 *
 * ## The falsifier
 *
 * Every acceptance criterion here can be satisfied by an implementation that computes what the
 * projection already ships, and a test that feeds it *consistent* data cannot tell the two apart:
 * `owned === total` and `complete` agree in every real game, so a green suite would prove nothing
 * (this is the gap the M3 review found in the server's own promoted-field tests). So the central
 * test in this file feeds a `group_holdings` whose `complete` **disagrees** with `owned === total`,
 * in both directions, and asserts the projected boolean wins. Delete `GroupHoldings.complete` from
 * the component and replace it with the comparison, and that test goes red — which is the only
 * evidence that the rule is not re-implemented here.
 *
 * The same shape of falsifier covers `net_worth`: a player whose worth disagrees with any sum of
 * their cash and their squares' prices.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { GroupHoldings, PlayerView } from "@/api";
import type { PropertyProjection } from "@/board";
import { makeBoard, makePlayer, makeTile } from "@/test/fixtures";
import { GROUP_ORDER, TOKEN_IDENTITY } from "@/theme";

import { PlayerDossier } from "./PlayerDossier";

const BOARD = makeBoard({
  tiles: [
    makeTile(1, { name_key: "tile.classic.mediterranean_avenue", group: "brown" }),
    makeTile(3, { name_key: "tile.classic.baltic_avenue", group: "brown" }),
    makeTile(6, { name_key: "tile.classic.oriental_avenue", group: "light_blue" }),
    makeTile(5, {
      name_key: "tile.classic.reading_railroad",
      kind: "railroad",
      group: null,
      house_cost: null,
    }),
    makeTile(12, {
      name_key: "tile.classic.electric_company",
      kind: "utility",
      group: null,
      house_cost: null,
    }),
  ],
});

function holdings(overrides: Partial<GroupHoldings> = {}): GroupHoldings {
  return {
    group: "brown",
    owned: 0,
    total: 2,
    complete: false,
    houses: 0,
    mortgaged_count: 0,
    ...overrides,
  };
}

/** All eight groups, as the projection always ships them, with named overrides applied. */
function allGroups(overrides: readonly Partial<GroupHoldings>[] = []): GroupHoldings[] {
  return GROUP_ORDER.map((group) => {
    const override = overrides.find((candidate) => candidate.group === group);
    return holdings({
      group,
      total: group === "brown" || group === "dark_blue" ? 2 : 3,
      ...override,
    });
  });
}

function property(overrides: Partial<PropertyProjection> = {}): PropertyProjection {
  return { owner: 0, houses: 0, mortgaged: false, ...overrides };
}

/** `state.properties` is positional by tile index, so the sparse slots have to be filled. */
function propertiesAt(at: Readonly<Record<number, PropertyProjection>>): PropertyProjection[] {
  const rows: PropertyProjection[] = [];
  for (let index = 0; index <= 40; index += 1) {
    rows[index] = at[index] ?? property({ owner: null });
  }
  return rows;
}

/**
 * A seat with the projection's real shape.
 *
 * `makePlayer` defaults `group_holdings` to `[]`, which no server ever sends — the projection ships
 * all eight colour groups precisely so a dossier table is never ragged. Defaulting it here keeps
 * every test about the thing it names instead of about a fixture's shortcut.
 */
function seat(overrides: Partial<PlayerView> = {}): PlayerView {
  return makePlayer(0, { group_holdings: allGroups(), ...overrides });
}

function renderDossier(player: PlayerView, properties = propertiesAt({}), extra = {}) {
  return render(
    <PlayerDossier
      player={player}
      players={[player, makePlayer(9, { name: "Dan" })]}
      board={BOARD}
      properties={properties}
      {...extra}
    />,
  );
}

describe("the projected numbers win — the falsifier", () => {
  it("shows the set complete when `complete` says so and `owned === total` does not", () => {
    // Two of three, and the engine nonetheless says the set is whole. There is no real game in
    // which this happens; that is the point. An implementation that wrote `owned === total` would
    // render "2 of 3" here and this test would fail.
    const player = seat({
      group_holdings: allGroups([{ group: "orange", owned: 2, total: 3, complete: true }]),
    });
    renderDossier(player);

    const row = screen.getByText("Orange").closest("li");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByTestId("group-progress")).toHaveTextContent(
      "Complete set",
    );
    expect(within(row as HTMLElement).queryByText("2 of 3")).not.toBeInTheDocument();
    expect((row as HTMLElement).dataset.complete).toBe("true");
  });

  it("shows the set incomplete when `complete` says so and `owned === total` does not", () => {
    // The other direction, which is the one that actually happens: the engine can hold a set
    // "not whole" for reasons the client is not told, and a UI that decided for itself would offer
    // a build affordance the engine will refuse.
    const player = seat({
      group_holdings: allGroups([{ group: "red", owned: 3, total: 3, complete: false }]),
    });
    renderDossier(player);

    const row = screen.getByText("Red").closest("li");
    expect(within(row as HTMLElement).getByTestId("group-progress")).toHaveTextContent("3 of 3");
    expect(within(row as HTMLElement).queryByText("Complete set")).not.toBeInTheDocument();
    expect((row as HTMLElement).dataset.complete).toBe("false");
  });

  it("prints the net worth the engine sent, not a sum of anything", () => {
    // 1500 in cash and one 60 square, and the engine says 4242. A mortgaged deed counts zero
    // (MON-208) and that is a rule; any arithmetic here would disagree with the engine sooner or
    // later, and this asserts there is none.
    const player = seat({ cash: 1500, net_worth: 4242, tiles_owned: [1] });
    renderDossier(player, propertiesAt({ 1: property() }));
    expect(screen.getByTestId("dossier-net-worth")).toHaveTextContent("4242");
    expect(screen.getByTestId("dossier-cash")).toHaveTextContent("1500");
  });

  it("takes houses and mortgage counts per set from the roll-up, not from the squares", () => {
    // Two squares owned, both undeveloped and unmortgaged in `state.properties` — and the roll-up
    // says four houses and one mortgage. The roll-up wins.
    const player = seat({
      tiles_owned: [1, 3],
      group_holdings: allGroups([
        { group: "brown", owned: 2, total: 2, complete: true, houses: 4, mortgaged_count: 1 },
      ]),
    });
    renderDossier(player, propertiesAt({ 1: property(), 3: property() }));

    const row = screen.getByText("Brown").closest("li") as HTMLElement;
    expect(within(row).getByTestId("group-houses")).toHaveTextContent("4");
    expect(within(row).getByTestId("group-mortgaged")).toHaveTextContent("1");
  });

  it("draws the completion pips from `owned` and `total`, not from the squares it grouped", () => {
    const player = seat({
      // One square filed under orange, and a roll-up that says two of three are held.
      tiles_owned: [6],
      group_holdings: allGroups([{ group: "orange", owned: 2, total: 3 }]),
    });
    renderDossier(player, propertiesAt({ 6: property() }));

    const row = screen.getByText("Orange").closest("li") as HTMLElement;
    const pips = within(row).getByTestId("set-pips");
    expect(pips.children).toHaveLength(3);
    expect([...pips.children].map((pip) => (pip as HTMLElement).dataset.owned)).toEqual([
      "true",
      "true",
      "false",
    ]);
  });
});

describe("holdings", () => {
  /** The nested fold holding the sets this player has nothing in. */
  function unstarted(): HTMLElement {
    const element = screen.getByTestId("dossier-unstarted");
    return element;
  }

  /** The group rows that are *not* inside that fold — the sets the player is actually in. */
  function heldRows(): readonly HTMLElement[] {
    return screen
      .getAllByTestId("group-row")
      .filter((row) => row.closest('[data-testid="dossier-unstarted"]') === null);
  }

  it("shows only the sets the player holds something in", () => {
    // The owner's second report: the card listed all ten bands, including the seven a mid-game player
    // owns nothing in, and those pushed the real holdings out of a fold that exists *because* the card
    // left no room for the history. `docs/UX_ACTION_PROMINENCE.md` §4.
    const player = seat({
      tiles_owned: [1, 3, 6],
      group_holdings: allGroups([
        { group: "brown", owned: 2, total: 2, complete: true },
        { group: "light_blue", owned: 1, total: 3 },
      ]),
    });
    renderDossier(player, propertiesAt({ 1: property(), 3: property(), 6: property() }));

    expect(heldRows().map((row) => row.dataset.group)).toEqual(["brown", "light_blue"]);
  });

  it("keeps the untouched sets reachable, folded, in the projection's order", () => {
    // Not dropped. "Which colours has nobody here started" is a real question around turn ten, and
    // answering it by counting the board is worse than answering it in one keystroke here.
    const player = seat({
      tiles_owned: [1],
      group_holdings: allGroups([{ group: "brown", owned: 1, total: 2 }]),
    });
    renderDossier(player, propertiesAt({ 1: property() }));

    expect(unstarted()).not.toHaveAttribute("open");
    const inside = within(unstarted())
      .getAllByTestId("group-row")
      .map((row) => row.dataset.group);
    expect(inside).toEqual(GROUP_ORDER.filter((group) => group !== "brown"));
  });

  it("still accounts for every set the projection sent, between the two lists", () => {
    // The property that makes the filter safe: a partition, not a filter. Nothing can fall out.
    const player = seat({
      tiles_owned: [6],
      group_holdings: allGroups([{ group: "light_blue", owned: 1, total: 3 }]),
    });
    renderDossier(player, propertiesAt({ 6: property() }));

    const all = screen.getAllByTestId("group-row").map((row) => row.dataset.group);
    expect(new Set(all)).toEqual(new Set(GROUP_ORDER));
    expect(all).toHaveLength(GROUP_ORDER.length);
  });

  it("shows no set at all for a player who has bought nothing", () => {
    renderDossier(seat());
    expect(heldRows()).toHaveLength(0);
    // …and the eight are one keystroke away rather than gone.
    expect(within(unstarted()).getAllByTestId("group-row")).toHaveLength(GROUP_ORDER.length);
  });

  it("keeps a set whose deed the roll-up has not caught up with", () => {
    // `owned > 0` **or** a deed was filed here. Losing a holding is a worse failure than showing one
    // without a fraction, which is the same argument the railroads-and-utilities list makes. A roll-up
    // that says zero while a square is filed under the band must not hide the square.
    const player = seat({
      tiles_owned: [6],
      group_holdings: allGroups([{ group: "light_blue", owned: 0, total: 3 }]),
    });
    renderDossier(player, propertiesAt({ 6: property() }));

    expect(heldRows().map((row) => row.dataset.group)).toEqual(["light_blue"]);
    expect(within(heldRows()[0] as HTMLElement).getByText("Oriental Avenue")).toBeInTheDocument();
  });

  it("keeps the completion figures on the sets it does show", () => {
    // The teaching moment stays. It is `0 of 3` that says nothing, not `2 of 3`.
    const player = seat({
      tiles_owned: [1, 3],
      group_holdings: allGroups([{ group: "brown", owned: 2, total: 2, complete: true }]),
    });
    renderDossier(player, propertiesAt({ 1: property(), 3: property() }));

    const brown = heldRows()[0] as HTMLElement;
    expect(within(brown).getByTestId("group-progress")).toHaveTextContent("Complete set");
    expect(within(brown).getByTestId("set-pips").children).toHaveLength(2);
  });

  it("names a set and files its squares underneath", () => {
    const player = seat({
      tiles_owned: [1, 3, 6],
      group_holdings: allGroups([
        { group: "brown", owned: 2, total: 2, complete: true },
        { group: "light_blue", owned: 1, total: 3 },
      ]),
    });
    renderDossier(player, propertiesAt({ 1: property(), 3: property(), 6: property() }));

    const brown = screen.getByText("Brown").closest("li") as HTMLElement;
    expect(within(brown).getAllByTestId("deed-row")).toHaveLength(2);
    expect(within(brown).getByText("Mediterranean Avenue")).toBeInTheDocument();
    expect(within(brown).getByText("Baltic Avenue")).toBeInTheDocument();

    const blue = screen.getByText("Light blue").closest("li") as HTMLElement;
    expect(within(blue).getAllByTestId("deed-row")).toHaveLength(1);
    expect(within(blue).getByText("Oriental Avenue")).toBeInTheDocument();
  });

  it("draws houses as pips and a hotel as one block, off the square's own `houses`", () => {
    const player = seat({ tiles_owned: [1, 3] });
    renderDossier(player, propertiesAt({ 1: property({ houses: 3 }), 3: property({ houses: 5 }) }));

    const rows = screen.getAllByTestId("deed-development");
    expect(rows[0]?.dataset.houses).toBe("3");
    expect(rows[0]?.dataset.hotel).toBe("false");
    expect(rows[0]?.querySelectorAll(".kesef-deed-house")).toHaveLength(3);
    expect(rows[1]?.dataset.hotel).toBe("true");
    expect(rows[1]?.querySelectorAll(".kesef-deed-hotel")).toHaveLength(1);
  });

  it("flags a mortgaged square in words, not only with a symbol", () => {
    const player = seat({ tiles_owned: [1] });
    renderDossier(player, propertiesAt({ 1: property({ mortgaged: true }) }));
    expect(screen.getByText("Mortgaged")).toBeInTheDocument();
  });

  it("says so plainly when nothing is owned", () => {
    renderDossier(seat({ tiles_owned: [] }));
    expect(screen.getByText("No properties yet")).toBeInTheDocument();
  });

  it("lists railroads and utilities under their own heading, with no invented fraction", () => {
    const player = seat({ tiles_owned: [5, 12] });
    renderDossier(player, propertiesAt({ 5: property(), 12: property() }));

    expect(screen.getByText("Railroads and utilities")).toBeInTheDocument();
    const rail = screen.getByText("Railroads").closest("li") as HTMLElement;
    expect(within(rail).getByText("Reading Railroad")).toBeInTheDocument();
    // `GroupHoldings.group` is typed `ColorGroup`, so the projection ships no roll-up for these —
    // and "1 of 4" would be this component counting a set, which is the one thing it must not do.
    expect(within(rail).queryByTestId("group-progress")).not.toBeInTheDocument();
    expect(within(rail).queryByTestId("set-pips")).not.toBeInTheDocument();
  });

  it("omits the other-holdings section entirely when none are held", () => {
    renderDossier(seat({ tiles_owned: [1] }), propertiesAt({ 1: property() }));
    expect(screen.queryByText("Railroads and utilities")).not.toBeInTheDocument();
  });

  it("heads each band with the city on the Israeli board, not with the colour", () => {
    /*
      On the physical Israeli edition a colour group *is* a city and its squares are streets in it.
      The colour name is not merely bland there, it is wrong: this card would otherwise print
      "dark blue" over a deed list reading Allenby St. and Dizengoff St., which are Tel Aviv.

      The board's own catalogue names each group (`board-israel.{en,he}.json`), and the resolver in
      `i18n/groupNames.ts` prefers it — see `groupNames.test.ts` for the fallback that keeps the
      classic board's colour names, which every other test in this file relies on.
    */
    const israel = makeBoard({
      id: "israel",
      name_key: "board.israel.name",
      tiles: [
        makeTile(37, { name_key: "tile.israel.t37", group: "dark_blue" }),
        makeTile(39, { name_key: "tile.israel.t39", group: "dark_blue" }),
      ],
    });
    const player = seat({
      tiles_owned: [37, 39],
      group_holdings: allGroups([{ group: "dark_blue", owned: 2, total: 2, complete: true }]),
    });
    render(
      <PlayerDossier
        player={player}
        players={[player]}
        board={israel}
        properties={propertiesAt({ 37: property(), 39: property() })}
      />,
    );

    const telAviv = screen.getByText("Tel Aviv").closest("li") as HTMLElement;
    expect(telAviv.dataset.group).toBe("dark_blue");
    // The streets under the heading are the reason the heading has to be the city.
    expect(within(telAviv).getByText("Allenby St.")).toBeInTheDocument();
    expect(within(telAviv).getByText("Dizengoff St.")).toBeInTheDocument();

    // Every band, not only the one holding deeds — a card showing one city and seven colours is
    // the half-routed failure this is really guarding.
    const cities = [
      "Eilat",
      "Tiberias",
      "Be'er Sheva",
      "Netanya",
      "Ramat Gan",
      "Jerusalem",
      "Haifa",
      "Tel Aviv",
    ];
    for (const city of cities) {
      expect(screen.getByText(city), `${city} band`).toBeInTheDocument();
    }
    expect(cities).toHaveLength(GROUP_ORDER.length);
    for (const colour of ["Dark blue", "Light blue", "Brown", "Orange", "Yellow", "Green"]) {
      expect(screen.queryByText(colour), `${colour} should not appear`).not.toBeInTheDocument();
    }
  });
});

describe("identity", () => {
  it("draws the seat's own piece — shape and colour and icon, from one table", () => {
    const { container } = renderDossier(seat());
    const piece = container.querySelector('svg[aria-hidden="true"] path[fill]');
    expect(piece).not.toBeNull();
    // Seat 1's plinth colour, from `TOKEN_IDENTITY`. Not a colour this component chose.
    expect(container.innerHTML).toContain(TOKEN_IDENTITY[0].color);
    expect(screen.getByText("Seat 1")).toBeInTheDocument();
  });

  it("gives every colour set a pattern as well as a band, so colour is never alone", () => {
    renderDossier(seat());
    const spines = screen.getAllByTestId("deed-spine");
    expect(spines).toHaveLength(GROUP_ORDER.length);
    const patterns = spines.map((spine) => spine.dataset.pattern);
    // A pattern per group and no two the same: the colourblind channel is only a channel if it
    // distinguishes.
    expect(new Set(patterns).size).toBe(patterns.length);
    for (const spine of spines) {
      expect(spine).toHaveAttribute("aria-hidden", "true");
      expect(spine.querySelector("rect")).toHaveAttribute("stroke", "var(--color-hairline)");
    }
  });

  it("keeps the keyline on every band — the band fill alone does not reach the floor", () => {
    // MON-412's contrast notes: yellow's fill measures about 1.4:1 against a card face and no
    // yellow that clears 3:1 is still yellow. The hairline rim is what makes the edge visible.
    renderDossier(seat());
    for (const spine of screen.getAllByTestId("deed-spine")) {
      const rect = spine.querySelector("rect");
      expect(rect?.getAttribute("stroke")).toBe("var(--color-hairline)");
      expect(Number(rect?.getAttribute("stroke-width"))).toBeGreaterThan(0);
    }
  });

  it("marks a bot, a jailed seat and a bankrupt seat in words", () => {
    renderDossier(
      seat({ is_bot: true, in_jail: true, bankrupt: true, kind: { bot_level: "easy" } }),
    );
    expect(screen.getByTestId("dossier-bot")).toHaveTextContent("Bot");
    expect(screen.getByTestId("dossier-jailed")).toHaveTextContent("In jail");
    expect(screen.getByTestId("dossier-bankrupt")).toHaveTextContent("Out of the game");
  });

  it("counts jail cards from the cards the seat holds", () => {
    renderDossier(seat({ jail_cards: ["chance", "community_chest"] }));
    expect(screen.getByTestId("dossier-jail-cards")).toHaveTextContent("2");
  });
});

describe("reachable for anybody, at any time", () => {
  it("renders another player's dossier with no gating on whose turn it is", () => {
    // Seat 9 is not the acting seat and this component does not ask. Holdings are public under the
    // universal rules (spec §5.2), so there is nothing to hide and no branch to write.
    const other = makePlayer(9, {
      name: "Dan",
      cash: 220,
      net_worth: 980,
      tiles_owned: [6],
      group_holdings: allGroups(),
    });
    render(
      <PlayerDossier
        player={other}
        players={[makePlayer(0, { name: "Ruti" }), other]}
        board={BOARD}
        properties={propertiesAt({ 6: property({ owner: 9 }) })}
      />,
    );
    expect(screen.getByTestId("dossier-cash")).toHaveTextContent("220");
    expect(screen.getByText("Oriental Avenue")).toBeInTheDocument();
    expect(screen.getByText("Seat 2")).toBeInTheDocument();
  });

  it("marks the acting seat without hiding anything from the others", () => {
    renderDossier(seat(), propertiesAt({}), { isCurrent: true });
    expect(screen.getByTestId("player-dossier").dataset.current).toBe("true");
  });
});

describe("squares as targets", () => {
  it("is a readout when no handler is given", () => {
    renderDossier(seat({ tiles_owned: [1] }), propertiesAt({ 1: property() }));
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("becomes a named target when one is, which is the seam G-53 asks for", async () => {
    const onSelectSquare = vi.fn();
    renderDossier(seat({ tiles_owned: [1] }), propertiesAt({ 1: property() }), {
      onSelectSquare,
    });
    const button = screen.getByRole("button", { name: "Open Mediterranean Avenue" });
    await userEvent.click(button);
    expect(onSelectSquare).toHaveBeenCalledWith(1);
    expect(button.className).toContain("target");
  });
});

describe("the dossier says nothing aloud", () => {
  it("renders no live region and no role that implies one", () => {
    const { container } = renderDossier(
      seat({ tiles_owned: [1, 5] }),
      propertiesAt({ 1: property({ houses: 2 }), 5: property() }),
    );
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(container.querySelectorAll('[role="log"],[role="status"],[role="alert"]')).toHaveLength(
      0,
    );
  });
});

describe("robustness", () => {
  it("survives a board with no catalogue rather than taking the card down", () => {
    // MON-503: `board-israel` is declared with no catalogue, and `missingKeyHandler` throws under
    // test by design. A card that renders "a square on the board" is far better than no card.
    const israel = makeBoard({ id: "israel", tiles: [makeTile(1, { name_key: "tile.israel.x" })] });
    const player = seat({ tiles_owned: [1] });
    render(
      <PlayerDossier
        player={player}
        players={[player]}
        board={israel}
        properties={propertiesAt({ 1: property() })}
      />,
    );
    expect(screen.getByText("a square on the board")).toBeInTheDocument();
  });

  it("renders before the board has arrived", () => {
    const player = seat({ tiles_owned: [1, 3] });
    render(<PlayerDossier player={player} players={[player]} board={undefined} properties={[]} />);
    // The figures are the projection's and do not need the board; only the square names do.
    expect(screen.getByTestId("dossier-squares")).toHaveTextContent("2");
    expect(screen.queryAllByTestId("deed-row")).toHaveLength(0);
  });

  it("ignores an owned index the board does not have", () => {
    const player = seat({ tiles_owned: [1, 999] });
    renderDossier(player, propertiesAt({ 1: property() }));
    expect(screen.getAllByTestId("deed-row")).toHaveLength(1);
  });

  describe("the deed list folds away", () => {
    // Owner feedback on the first playable build: the card left no room for the history beside it.
    // Only the deed list folds — the figures stay open, because cash and net worth are what a player
    // checks between moves, and the deed list is the part that grows and squeezes the log by turn
    // thirty.
    /**
     * The outer `<details>` — the deed list's own fold.
     *
     * `querySelector` takes the first in document order, which is this one; the nested fold holding
     * the untouched sets is inside it and is reached by its test id instead.
     */
    function fold(): HTMLDetailsElement {
      const element = screen.getByTestId("player-dossier").querySelector("details");
      expect(element, "the deed list is not inside a <details>").not.toBeNull();
      return element as HTMLDetailsElement;
    }

    it("nests the untouched sets inside it, so one fold hides the whole list", () => {
      const player = seat({ tiles_owned: [1] });
      renderDossier(player, propertiesAt({ 1: property() }));
      // Otherwise the "sets with no properties" row would sit outside the fold and be the one thing a
      // closed card still showed, which is the opposite of the point.
      expect(fold().contains(screen.getByTestId("dossier-unstarted"))).toBe(true);
    });

    it("starts closed, with the figures still showing", () => {
      const player = seat({ tiles_owned: [1, 3] });
      renderDossier(player, propertiesAt({ 1: property(), 3: property() }));

      // Asserted on the `open` attribute rather than with `toBeVisible`. jsdom implements `<details>`
      // as an element but applies none of the UA stylesheet that actually hides a closed one, so its
      // children report as visible either way — the same class of blind spot as `scrollHeight` being
      // 0 for everything. Whether the list is *painted* is asserted in `e2e/dossier.spec.ts`.
      expect(fold().open).toBe(false);
      expect(screen.getByTestId("dossier-cash")).toBeVisible();
      expect(screen.getByTestId("dossier-net-worth")).toBeVisible();
    });

    it("says how many squares while still closed, so the fold costs no information", () => {
      const player = seat({ tiles_owned: [1, 3] });
      renderDossier(player, propertiesAt({ 1: property(), 3: property() }));

      // A closed card still answers "how many squares", which is what the list is usually consulted
      // for. Read from inside the summary, so a count rendered elsewhere cannot satisfy this.
      const summary = fold().querySelector("summary");
      expect(summary).toHaveTextContent("Properties");
      expect(summary).toHaveTextContent("2 squares");
    });

    it("opens when the summary is activated", async () => {
      const player = seat({ tiles_owned: [1, 3] });
      renderDossier(player, propertiesAt({ 1: property(), 3: property() }));

      // The summary element itself, not the text: "Properties" is also the label of the figure above
      // it, which is the point of that figure — the count and the list are named the same thing.
      const summary = fold().querySelector("summary");
      await userEvent.click(summary as HTMLElement);
      expect(fold().open).toBe(true);
    });
  });
});
