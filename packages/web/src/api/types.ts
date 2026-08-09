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

/**
 * A newly seated game and the one credential for it (ADR-012, MON-906).
 *
 * `POST /games` and `POST /games/load` both answer this. It is a **`GameView` plus `host_secret`**
 * (the server subclasses one), so it is dual-readable across a non-atomic deploy: an old cached
 * client reads `state.game_id` off the top level, a new client reads `host_secret`. Only
 * `api/client.ts` names the type — the secret is stripped there and every layer above is handed a
 * plain `GameView`.
 */
export type GameCreated = Schemas["GameCreated"];
/** The answer to a seat claim: that seat's secret, and the view filtered to it. */
export type SeatClaimed = Schemas["SeatClaimed"];
/**
 * One human seat and whether it is taken — `GameView.claims` (ADR-012).
 *
 * The whole of what a joiner is told about seat authority, and the input to the seat picker. Human
 * seats only: a bot seat is not a seat anybody can claim, and `PlayerView.is_bot` is where the UI
 * reads that.
 */
export type SeatClaimView = Schemas["SeatClaimView"];
/**
 * Who this connection speaks for — `GameView.speaker` (ADR-012, MON-906).
 *
 * The projection's own answer to "who am I here", which the client reads instead of inferring it
 * from `localStorage`. A voided or replaced secret resolves to `spectator` in the next view, so the
 * seat picker reappears and the holder can re-claim — the self-heal the root-cause fix buys.
 */
export type SpeakerView = Schemas["SpeakerView"];

export type NewGameRequest = Schemas["NewGameRequest"];
/**
 * The per-game amendments a table may make to the named rule set (MON-712).
 *
 * Named here rather than inlined at the one call site so the setup screen's state is typed by the
 * *contract* — a field the server stops accepting becomes a compile error on the screen that
 * offers it, which is the whole reason this package generates its types.
 */
export type HouseRules = Schemas["HouseRules"];
export type AuctionMinimum = Schemas["AuctionMinimum"];
export type SeatConfig = Schemas["SeatConfig"];
export type BoardSummary = Schemas["BoardSummary"];
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

/**
 * A save file: the state, and the events that produced it (ADR-011).
 *
 * The envelope `GET /games/{id}/save` answers with and `POST /games/load` accepts. It exists
 * because a session is more than a `GameState` — the event log is not a state field, so a restored
 * game used to come back with its board exactly right and no history at all.
 *
 * `state` carries the same hidden information the bare `GameState` did, and the same rule applies:
 * nothing in this package reads a field of it. `SaveGameButton` reads `state.game_id` and
 * `state.turn_number` to *name the file*, which is the one exception and is not a rule.
 */
export type SaveFile = Schemas["SaveFile"];

/**
 * What a load should do when that save's game is already live (ADR-011, MON-714).
 *
 * `"refuse"` is the default and the first attempt; the other two are what the player answered when
 * the refusal asked them. The engine does not decide this and neither does the UI — the *player*
 * does, and this is the shape their answer travels in.
 */
export type IfExists = Schemas["IfExists"];

/** Narrow a `GameEvent` to one member of the union by its `type` tag. */
export type EventOfType<T extends GameEventType> = Extract<GameEvent, { type: T }>;

/** Narrow a `Command` to one member of the union by its `kind` tag. */
export type CommandOfKind<K extends CommandKind> = Extract<Command, { kind: K }>;
