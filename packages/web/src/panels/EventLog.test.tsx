/**
 * What these tests are for, in order of how expensive the defect would be.
 *
 * 1. **Every event type renders a translated sentence** — not a key, not an enum value. The
 *    table-driven case below walks all 24 types, so a new event with no catalogue entry fails
 *    here rather than showing `log.whatever` to a player.
 * 2. **The log has no live region.** MON-411 owns narration; a second region announcing the
 *    same roll is double-speak (G-54). Asserted structurally, including the `role` values that
 *    carry an *implicit* live region.
 * 3. **Newest first**, and self-contained: the numbers come off the event.
 */

import { cleanup, render, screen } from "@testing-library/react";
import i18next from "i18next";
import { describe, expect, it } from "vitest";

import type { BoardView, GameEvent, GameEventType, LoggedEvent, PlayerView } from "@/api";

import { loggedEvent, makeBoard, makePlayer, makeTile } from "../test/fixtures";
import { EventLog } from "./EventLog";
import { resolveNoteParams, SILENT_EVENTS } from "./EventLogLines";

const PLAYERS: readonly PlayerView[] = [
  makePlayer(0, { name: "Ruti" }),
  makePlayer(1, { name: "Dan" }),
];

const BOARD: BoardView = makeBoard({
  tiles: [
    makeTile(0, { kind: "go", group: null, is_ownable: false }),
    makeTile(1, { name_key: "tile.classic.mediterranean_avenue" }),
    makeTile(3, { name_key: "tile.classic.baltic_avenue" }),
  ],
});

function renderLog(events: readonly LoggedEvent[]): void {
  render(<EventLog events={events} players={PLAYERS} board={BOARD} />);
}

/** Everything the panel says, rent explanations included — a nested `<ul>` is a list too. */
function logText(): string {
  return screen.getByRole("region", { name: i18next.t("log.title") }).textContent;
}

/** The 24-member sample. Every member of the event union appears exactly once. */
const SAMPLE: Readonly<Record<GameEventType, GameEvent>> = {
  turn_started: { type: "turn_started", player: 0, turn_number: 4 },
  dice_rolled: {
    type: "dice_rolled",
    player: 0,
    first: 3,
    second: 4,
    total: 7,
    doubles_streak: 0,
    purpose: "move",
  },
  token_moved: {
    type: "token_moved",
    player: 0,
    from_tile: 0,
    to_tile: 1,
    forward: true,
    passed_go: false,
  },
  cash_changed: {
    type: "cash_changed",
    player: 0,
    delta: -50,
    reason: "mortgage_transfer_fee",
    balance: 1450,
    counterparty: "bank",
  },
  rent_charged: {
    type: "rent_charged",
    payer: 1,
    owner: 0,
    tile: 1,
    amount: 4,
    base_rent: 2,
    houses: 0,
    multiplier: 2,
    dice_total: null,
    group: "brown",
    note_keys: ["rent.note.full_group_doubled"],
    // `group_key`, not `group: "brown"`: the engine sends a catalogue key now (MON-415), so the
    // log resolves it generically instead of holding a `Record<ColorGroup, string>` of its own.
    note_params: { group_key: "group.brown", multiplier: 2 },
  },
  property_acquired: { type: "property_acquired", player: 0, tile: 1, price: 60, via: "auction" },
  auction_started: {
    type: "auction_started",
    lot: { kind: "tile", tile: 1 },
    reason: "declined_purchase",
    eligible: [0, 1],
  },
  bid_placed: { type: "bid_placed", player: 1, amount: 70 },
  bidder_withdrew: { type: "bidder_withdrew", player: 1 },
  auction_ended: { type: "auction_ended", lot: { kind: "tile", tile: 1 }, winner: 0, price: 70 },
  card_drawn: { type: "card_drawn", player: 0, deck: "community_chest", card_id: "bank_error" },
  sent_to_jail: { type: "sent_to_jail", player: 0, via: "three_doubles" },
  left_jail: { type: "left_jail", player: 0, via: "time_served" },
  building_changed: { type: "building_changed", tile: 1, houses: 3, delta: 1, level: "house" },
  mortgage_changed: { type: "mortgage_changed", player: 0, tile: 1, mortgaged: true },
  trade_proposed: { type: "trade_proposed", offer: OFFER() },
  trade_executed: { type: "trade_executed", offer: OFFER() },
  trade_declined: { type: "trade_declined", offer: OFFER() },
  trade_cancelled: { type: "trade_cancelled", offer: OFFER(), by: "system" },
  debt_incurred: { type: "debt_incurred", debtor: 1, creditor: "bank", amount: 120 },
  debt_settled: { type: "debt_settled", debtor: 1, creditor: 0, amount: 120 },
  player_bankrupted: {
    type: "player_bankrupted",
    player: 1,
    creditor: "bank",
    tiles_transferred: [1],
    cash_transferred: 0,
    jail_cards_transferred: [],
    shares: [],
  },
  phase_changed: { type: "phase_changed", previous: "awaiting_roll", current: "auction" },
  game_ended: { type: "game_ended", winner: 0, reason: "last_solvent", final_standings: [] },
};

function OFFER(): Extract<GameEvent, { type: "trade_proposed" }>["offer"] {
  return {
    proposer: 0,
    recipient: 1,
    give: { cash: 100, tiles: [], jail_cards: [] },
    receive: { cash: 0, tiles: [1], jail_cards: [] },
  };
}

describe("every event type", () => {
  const rendered = Object.entries(SAMPLE).filter(
    ([type]) => !SILENT_EVENTS.has(type as GameEventType),
  );

  it.each(rendered)("renders %s as a translated sentence, not a key or an enum", (_type, event) => {
    renderLog([loggedEvent(1, event)]);
    const text = logText();
    expect(text.length).toBeGreaterThan(i18next.t("log.title").length);
    // A key that failed to resolve, an untranslated enum member, or a snake_case identifier
    // leaking into prose all look the same from here — and all three are the same defect.
    expect(text).not.toMatch(/\b[a-z]+(_[a-z]+)+\b/);
    expect(text).not.toContain("log.");
  });

  it("covers the whole union, so a new event type cannot be forgotten", () => {
    // `SAMPLE` is `Record<GameEventType, …>`, so this is really asserting the count the
    // compiler already checked — it is here to make the coverage visible in the report.
    expect(Object.keys(SAMPLE)).toHaveLength(24);
    expect(rendered).toHaveLength(23);
  });

  it("keeps phase_changed out of the history on purpose", () => {
    renderLog([loggedEvent(1, SAMPLE.phase_changed)]);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByText(i18next.t("log.empty"))).toBeInTheDocument();
  });
});

describe("the log narrates nothing", () => {
  it("mounts no aria-live region of its own", () => {
    renderLog([loggedEvent(1, SAMPLE.dice_rolled)]);
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(0);
  });

  it("uses no role that carries an implicit live region", () => {
    renderLog([loggedEvent(1, SAMPLE.dice_rolled)]);
    for (const role of ["log", "status", "alert", "marquee", "timer"]) {
      expect(screen.queryAllByRole(role)).toHaveLength(0);
    }
  });
});

describe("ordering and self-containment", () => {
  it("puts the newest entry first", () => {
    renderLog([
      loggedEvent(1, SAMPLE.dice_rolled),
      loggedEvent(2, { type: "bid_placed", player: 1, amount: 70 }),
    ]);
    const items = screen.getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("bid 70");
    expect(items[1]?.textContent).toContain("rolled 3 and 4");
  });

  it("renders the amounts the event carries, not the seat's current cash", () => {
    renderLog([
      loggedEvent(1, {
        type: "rent_charged",
        payer: 1,
        owner: 0,
        tile: 1,
        amount: 4,
        base_rent: 2,
        houses: 0,
        multiplier: 2,
        dice_total: null,
        group: "brown",
        note_keys: [],
      }),
    ]);
    expect(logText()).toContain("Dan paid Ruti 4 in rent");
  });

  it("resolves the group key inside a rent note rather than printing it", () => {
    renderLog([loggedEvent(1, SAMPLE.rent_charged)]);
    const text = logText();
    expect(text).toContain("Brown");
    // Neither the enum value nor the key itself reaches the sentence (MON-415).
    expect(text).not.toContain("brown");
    expect(text).not.toContain("group.");
  });

  it("names the city, not the colour, when the rent note is about the Israeli board", () => {
    /*
      The doubling sentence is the site most likely to be missed, because the group reaches it as a
      *param* rather than as a label a component chose: `rent.note.full_group_doubled` says "one
      player owns the whole {{group}} set", and the engine fills `group_key` with `group.dark_blue`.
      On the Israeli board that group is Tel Aviv, and a log reading "the whole dark blue set" beside
      a dossier reading "Tel Aviv" is the exact split this routing exists to prevent.
    */
    const israel = makeBoard({
      id: "israel",
      name_key: "board.israel.name",
      tiles: [makeTile(37, { name_key: "tile.israel.t37", group: "dark_blue" })],
    });
    render(
      <EventLog
        events={[
          loggedEvent(1, {
            type: "rent_charged",
            payer: 1,
            owner: 0,
            tile: 37,
            amount: 100,
            base_rent: 50,
            houses: 0,
            multiplier: 2,
            dice_total: null,
            group: "dark_blue",
            note_keys: ["rent.note.full_group_doubled"],
            note_params: { group_key: "group.dark_blue", multiplier: 2 },
          }),
        ]}
        players={PLAYERS}
        board={israel}
      />,
    );
    const text = logText();
    expect(text).toContain("Tel Aviv");
    expect(text).not.toContain("dark blue");
    expect(text).not.toContain("Dark blue");
    // The square's own name still comes from the same board catalogue, so the two agree.
    expect(text).toContain("Allenby St.");
  });

  it("says hotel or house, never 'building'", () => {
    // MON-413. `level` is the engine's answer to "which building moved", so the log stopped saying
    // "a building went up" — and the client never had to encode "five houses is a hotel".
    renderLog([
      loggedEvent(1, { type: "building_changed", tile: 1, houses: 5, delta: 1, level: "hotel" }),
    ]);
    expect(logText()).toContain(i18next.t("log.hotel_built", { tile: "Mediterranean Avenue" }));

    cleanup();
    renderLog([
      loggedEvent(2, { type: "building_changed", tile: 1, houses: 5, delta: -5, level: "hotel" }),
    ]);
    expect(logText()).toContain(i18next.t("log.hotel_sold", { tile: "Mediterranean Avenue" }));
  });

  it("pluralizes a house sale by how many came down, and never pluralizes a hotel", () => {
    renderLog([
      loggedEvent(1, { type: "building_changed", tile: 1, houses: 1, delta: -2, level: "house" }),
    ]);
    expect(logText()).toContain("2 houses came down");
  });

  it("names who mortgaged, in the active voice", () => {
    // MON-414. The passive voice was the honest rendering while the event carried no player.
    renderLog([loggedEvent(1, { type: "mortgage_changed", player: 1, tile: 1, mortgaged: true })]);
    const text = logText();
    expect(text).toContain("Dan mortgaged");
    expect(text).not.toContain("was mortgaged");

    cleanup();
    renderLog([loggedEvent(2, { type: "mortgage_changed", player: 0, tile: 1, mortgaged: false })]);
    expect(logText()).toContain("Ruti paid off the mortgage");
  });

  it("names the cash reason in words", () => {
    renderLog([loggedEvent(1, SAMPLE.cash_changed)]);
    expect(logText()).toContain("Ruti paid 50 for mortgage transfer fee");
  });

  it("draws a turn boundary as a labelled marker", () => {
    renderLog([loggedEvent(1, SAMPLE.turn_started)]);
    expect(screen.getByText("Turn 4 begins · Ruti")).toBeInTheDocument();
  });

  it("keeps only the newest maxEntries rows", () => {
    const events = Array.from({ length: 5 }, (_unused, index) =>
      loggedEvent(index + 1, { type: "bid_placed", player: 1, amount: (index + 1) * 10 }),
    );
    render(<EventLog events={events} players={PLAYERS} board={BOARD} maxEntries={2} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("50");
    expect(items[1]?.textContent).toContain("40");
  });

  it("survives a tile the board has not supplied", () => {
    renderLog([
      loggedEvent(1, { type: "mortgage_changed", player: 0, tile: 39, mortgaged: false }),
    ]);
    expect(logText()).toBeTruthy();
  });

  it("shows an invitation rather than an empty box before the first roll", () => {
    renderLog([]);
    expect(screen.getByText(i18next.t("log.empty"))).toBeInTheDocument();
  });
});

describe("the scrollable history is reachable without a mouse", () => {
  it("makes the scroll container focusable, and names the panel exactly once", () => {
    renderLog([loggedEvent(1, SAMPLE.dice_rolled)]);
    // axe's `scrollable-region-focusable`: an overflow box with nothing focusable inside it
    // cannot be scrolled from the keyboard at all.
    expect(screen.getByRole("list").closest("[tabindex]")).toHaveAttribute("tabindex", "0");
    expect(screen.getAllByRole("region", { name: i18next.t("log.title") })).toHaveLength(1);
  });
});

describe("resolving the keys inside a note's params (MON-415)", () => {
  /** Echoes the key it was given, so the assertions are about *which* value was translated. */
  const translate = (key: string): string => `translated:${key}`;

  /**
   * A scope with no board-scoped entry to find.
   *
   * `exists: () => false` is the classic board's own behaviour — it defines no `group.*` key — so
   * these four assertions describe the fallback path, and the board-scoped path is asserted
   * separately below and in `i18n/groupNames.test.ts`.
   */
  const scope = { boardId: undefined, translate, exists: (): boolean => false };

  it("resolves a `*_key` param into its bare name and drops the suffixed entry", () => {
    expect(resolveNoteParams({ group_key: "group.brown", multiplier: 2 }, scope)).toEqual({
      group: "translated:group.brown",
      multiplier: 2,
    });
  });

  it("leaves an ordinary param alone, whatever its value looks like", () => {
    // `count` is a number and `houses` is a plain value; neither names a catalogue entry, and a
    // resolver that translated everything would put `translated:3` in front of a child.
    expect(resolveNoteParams({ count: 3, houses: 2 }, scope)).toEqual({
      count: 3,
      houses: 2,
    });
  });

  it("knows nothing about colour groups — any namespace resolves the same way", () => {
    // The point of the convention over the deleted `Record<ColorGroup, string>`: the next engine
    // note to interpolate a key needs no change here at all.
    expect(resolveNoteParams({ deck_key: "deck.chance" }, scope)).toEqual({
      deck: "translated:deck.chance",
    });
  });

  it("survives an absent params object", () => {
    expect(resolveNoteParams(undefined, scope)).toEqual({});
  });

  it("prefers the board's own name for a group, and only for a group", () => {
    // The Israeli board names each colour group after its city, so the note that interpolates a
    // group has to reach `board-israel:group.dark_blue` — while `deck_key`, which no board renames,
    // stays on the global catalogue even though the same board is in play.
    const israel = {
      boardId: "israel",
      translate,
      exists: (key: string): boolean => key === "board-israel:group.dark_blue",
    };
    expect(
      resolveNoteParams({ group_key: "group.dark_blue", deck_key: "deck.chance" }, israel),
    ).toEqual({
      group: "translated:board-israel:group.dark_blue",
      deck: "translated:deck.chance",
    });
  });
});
