/**
 * Names for the wire shapes, aliased out of `generated.ts`.
 *
 * Every type here is an alias — never a redeclaration. `generated.ts` is produced from the
 * server's OpenAPI document (MON-302), so a field renamed in `schemas.py` becomes a
 * TypeScript error in this package rather than an `undefined` at runtime. Hand-writing a
 * shape the generator already declares would break exactly that property, so this file is
 * allowed to contain `components["schemas"][...]` lookups and nothing else.
 */

import type { components } from "./generated";

type Schemas = components["schemas"];

/** The projection (ADR-008): everything a client needs to render one frame. */
export type GameView = Schemas["GameView"];
export type BoardView = Schemas["BoardView"];
export type TileView = Schemas["TileView"];
export type GameStateView = Schemas["GameStateView"];
export type PlayerView = Schemas["PlayerView"];
export type GroupHoldings = Schemas["GroupHoldings"];
export type DiceView = Schemas["DiceView"];
export type InterruptFrameView = GameStateView["interrupts"][number];
export type Phase = Schemas["Phase"];
export type ColorGroup = Schemas["ColorGroup"];
export type PlayerId = PlayerView["id"];

/**
 * The command union, taken from the request body rather than restated.
 *
 * `CommandRequest.command` and `GameView.legal_commands[number]` are the same union in the
 * document; reading it off the request is what guarantees that every command
 * `legal_commands` hands us is a command `send` can post (ADR-005 soundness, client side).
 */
export type Command = Schemas["CommandRequest"]["command"];
export type CommandKind = Command["kind"];

/** One event with the session-assigned `seq` — the same envelope on HTTP and WebSocket. */
export type LoggedEvent = Schemas["LoggedEvent"];
export type GameEvent = LoggedEvent["event"];
export type GameEventType = GameEvent["type"];

export type ErrorResponse = Schemas["ErrorResponse"];
export type ErrorParams = ErrorResponse["params"];
export type LegalityView = Schemas["LegalityView"];

export type NewGameRequest = Schemas["NewGameRequest"];
export type SeatConfig = Schemas["SeatConfig"];
export type BoardSummary = Schemas["BoardSummary"];
export type GameSummary = Schemas["GameSummary"];
export type Ruleset = Schemas["Ruleset"];

/**
 * A rule set as `/rulesets` returns it: identified, labelled, and explained (MON-417).
 *
 * `RulesetView` is what the setup screen reads. The bare `Ruleset` is still aliased above because
 * the *game* screen reads flags off `state.ruleset` — `jail_fine`, `simplified_trades` — which is a
 * copy rather than a diff.
 */
export type RulesetView = Schemas["RulesetView"];
export type RuleFlagView = Schemas["RuleFlagView"];
/** One rule's value, tagged by kind so nothing has to sniff at `boolean | number | number[]`. */
export type RuleValue = RuleFlagView["value"];

/** What a square would charge, sharing its shape with `RentCharged` (MON-420). */
export type RentQuote = Schemas["RentQuote"];

/**
 * The save file — the only shape that carries hidden information (ADR-008 §2).
 *
 * Exposed so `GET /games/{id}/save` and `POST /games/load` are typed, and deliberately not
 * used anywhere else: the RNG and the deck order live in here, and a screen that reads them
 * is a cheat channel.
 */
export type GameState = Schemas["GameState"];

/** Narrow a `GameEvent` to one member of the union by its `type` tag. */
export type EventOfType<T extends GameEventType> = Extract<GameEvent, { type: T }>;

/** Narrow a `Command` to one member of the union by its `kind` tag. */
export type CommandOfKind<K extends CommandKind> = Extract<Command, { kind: K }>;
