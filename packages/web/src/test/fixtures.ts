/**
 * Fixtures for the projection, built from the generated types.
 *
 * Deliberately a *builder* rather than a pile of literals: a `GameView` is large, and a test
 * that spells one out in full drowns the two fields it is actually about. Everything here is
 * typed against `generated.ts`, so a contract change breaks the fixtures — which is the point.
 *
 * `ruleset` is the one narrow cast. It is a fully expanded engine model with a few dozen
 * flags, none of which any test in this package reads; restating it would add noise and a
 * second place to update when a flag is added.
 */

import type {
  BoardView,
  Command,
  GameStateView,
  GameView,
  LoggedEvent,
  PlayerView,
  Ruleset,
  TileView,
} from "@/api";

const RULESET = { name: "universal" } as unknown as Ruleset;

export function makeTile(index: number, overrides: Partial<TileView> = {}): TileView {
  return {
    index,
    kind: "property",
    name_key: `tile.classic.t${String(index)}`,
    group: "brown",
    price: 60,
    rent: [2, 10, 30, 90, 160, 250],
    house_cost: 50,
    mortgage: 30,
    tax: null,
    is_ownable: true,
    ...overrides,
  };
}

export function makePlayer(id: number, overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    id,
    name: `Player ${String(id)}`,
    // `PlayerKind` carries only `bot_level` — a `null` level *is* a human seat (G-19).
    kind: { bot_level: null },
    token: "cat",
    cash: 1500,
    position: 0,
    in_jail: false,
    jail_turns: 0,
    jail_cards: [],
    bankrupt: false,
    grammatical_gender: "n",
    net_worth: 1500,
    group_holdings: [],
    tiles_owned: [],
    is_bot: false,
    ...overrides,
  };
}

export function makeBoard(overrides: Partial<BoardView> = {}): BoardView {
  return {
    id: "classic",
    name_key: "board.classic.name",
    tiles: [
      makeTile(0, {
        kind: "go",
        group: null,
        price: null,
        rent: [],
        house_cost: null,
        mortgage: null,
        is_ownable: false,
      }),
      makeTile(1),
      makeTile(2, { name_key: "tile.classic.t2" }),
    ],
    go_to_jail_target: 10,
    ...overrides,
  };
}

export function makeState(overrides: Partial<GameStateView> = {}): GameStateView {
  return {
    schema_version: 1,
    game_id: "g1",
    board_id: "classic",
    ruleset: RULESET,
    locale: "en",
    players: [makePlayer(0, { name: "Ruti" }), makePlayer(1, { name: "Dan" })],
    properties: [],
    phase: "awaiting_roll",
    current_player_id: 0,
    dice: null,
    doubles_streak: 0,
    turn_number: 1,
    interrupts: [],
    deck_counts: { chance: 16, community_chest: 16 },
    free_parking_pot: 0,
    elapsed_seconds: 0,
    elimination_order: [],
    winner: null,
    houses_remaining: 32,
    hotels_remaining: 12,
    ...overrides,
  };
}

export function makeView(overrides: Partial<GameView> = {}): GameView {
  return {
    board: makeBoard(),
    state: makeState(),
    legal_commands: [],
    events: [],
    event_cursor: 0,
    ...overrides,
  };
}

export const ROLL_DICE: Command = { kind: "roll_dice", player: 0 };

export function loggedEvent(seq: number, event: LoggedEvent["event"]): LoggedEvent {
  return { seq, event };
}
