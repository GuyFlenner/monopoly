/**
 * The typed HTTP client. One method per route, and no opinions about the game.
 *
 * Two properties this file exists to hold:
 *
 * 1. **Every shape comes from `generated.ts`.** The aliases live in `./types`; nothing here
 *    describes a request or response body in its own words, so a contract change is a
 *    compile error rather than a runtime surprise (MON-302).
 * 2. **Every failure leaves as an {@link ApiError}.** The server answers
 *    `{reason_key, params}` on 4xx and 5xx alike (ADR-008 §4); this client parses both
 *    halves and throws them as data. A caller translates the key. It never receives prose,
 *    and it never receives a bare string or a `TypeError` from `fetch`.
 *
 * There is no third property, and in particular there is no rule: this file does not know
 * what a command is for, whether one is legal, or what a number on the board means.
 *
 * ## And since MON-906, one credential (ADR-012)
 *
 * A game is joined by link, so the server has to be told which seat a request speaks for. That is a
 * secret it minted and handed over once — at creation, or when a seat was claimed — and this client
 * is where it is kept and re-presented:
 *
 * * **Stored on the way in.** `createGame`, `loadGame` and `claimSeat` are the only three answers
 *   that carry a secret, and each writes it to the {@link SecretStore} before returning. Nothing
 *   above this file ever handles one, which is the property worth having: a secret that reached a
 *   component would sooner or later reach a prop, a log line, or a URL.
 * * **Sent on the way out.** Every `/games/{id}` request carries `Authorization: Bearer <secret>`
 *   when one is held. A header rather than a query parameter, because a URL lands in history, in a
 *   `Referer`, and in whatever a parent pastes into a chat window.
 * * **Absent is a working state.** With no secret the server answers as a spectator: the whole
 *   board, and an empty `legal_commands`. So a client that has never claimed a seat renders a game
 *   rather than an error, and the UI's "no buttons" is a fact from the server rather than a guess.
 */

import {
  ApiError,
  asApiError,
  isErrorResponse,
  toErrorParams,
  TRANSPORT_ERROR_KEY,
} from "./errors";
import { browserSecretStore, type SecretStore } from "./secretStore";
import type {
  BoardSummary,
  Command,
  GameCreated,
  GameView,
  IfExists,
  LegalityView,
  NewGameRequest,
  RulesetView,
  SaveFile,
  SeatClaimed,
} from "./types";

/** Just enough of `fetch` to be substitutable in a test. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The subset of `WebSocket` this client uses.
 *
 * Declared structurally so a test can hand over a fake without a jsdom `WebSocket`
 * implementation, and so nothing in `eventSocket.ts` can reach for a method that a fake
 * would then have to grow.
 */
export interface SocketLike {
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface ApiClientOptions {
  /**
   * Where the API lives. Defaults to {@link defaultBaseUrl}.
   *
   * The Vite dev proxy puts it at `/api`, same-origin — which is every deployment except the one
   * MON-901 adds, where the page is on GitHub Pages and the API is on Render.
   */
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly createSocket?: SocketFactory;
  /** Absolute base for resolving the WebSocket URL. Defaults to the document's location. */
  readonly origin?: string;
  /**
   * Where this browser keeps its seat credentials (ADR-012). Defaults to `localStorage`.
   *
   * Injected for the reason `fetch` is: the failing-storage branch is the one that matters and a
   * real browser only produces it in private mode.
   */
  readonly secrets?: SecretStore;
}

export const DEFAULT_BASE_URL = "/api";

/**
 * Where the API is, for a client that was not told.
 *
 * `VITE_API_URL` when the build set one, `/api` otherwise — and `/api` stays the default on purpose,
 * because same-origin is every deployment except the split one. A relative path is also the *safer*
 * default: it cannot accidentally point a developer's browser at production.
 *
 * Nothing downstream needs to know which it got. `request` concatenates and `eventStreamUrl` resolves
 * through `new URL(path, base)`, where an absolute path simply wins over the page's origin — so an
 * `https://` value yields `wss://` for the event stream by the same line that already turned an https
 * *page* into a `wss` socket. Verified in `client.test.ts` rather than reasoned about, since "the
 * socket quietly opened unencrypted" is not a failure you would see.
 *
 * A trailing slash is trimmed by the constructor, so `https://host/` and `https://host` behave alike.
 */
export function defaultBaseUrl(): string {
  const configured = import.meta.env.VITE_API_URL;
  return configured !== undefined && configured.trim() !== ""
    ? configured.trim()
    : DEFAULT_BASE_URL;
}

/** 204 has no body, and `response.json()` on an empty body is a `SyntaxError`. */
const NO_CONTENT = 204;

export class ApiClient {
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly makeSocket: SocketFactory;
  private readonly origin: string | undefined;
  private readonly secrets: SecretStore;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? defaultBaseUrl()).replace(/\/$/, "");
    this.doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.makeSocket = options.createSocket ?? ((url) => new WebSocket(url) as SocketLike);
    this.origin = options.origin;
    this.secrets = options.secrets ?? browserSecretStore();
  }

  /**
   * Whether this browser holds a credential for `gameId` (ADR-012).
   *
   * The one thing above this file may ask about a secret, and it is a boolean rather than the
   * string: the seat-claim affordance needs to know whether to offer itself, and nothing in the UI
   * needs — or should be able — to read the credential itself.
   */
  holdsSeat(gameId: string): boolean {
    return this.secrets.get(gameId) !== undefined;
  }

  /** Forget this browser's credential for `gameId`, on leaving the game. */
  forgetSeat(gameId: string): void {
    this.secrets.clear(gameId);
  }

  // --- Meta ---------------------------------------------------------------

  listBoards(signal?: AbortSignal): Promise<BoardSummary[]> {
    return this.request<BoardSummary[]>("GET", "/boards", { signal });
  }

  listRulesets(signal?: AbortSignal): Promise<RulesetView[]> {
    return this.request<RulesetView[]>("GET", "/rulesets", { signal });
  }

  // --- Games --------------------------------------------------------------

  /**
   * Start a game, and keep the host secret it answers with (ADR-012).
   *
   * The answer is a `GameCreated` envelope — the view *and* the one credential this session will
   * ever hand out — so the secret is stored here, at the only moment it exists, and the caller is
   * given the view it was going to use anyway.
   */
  async createGame(request: NewGameRequest, signal?: AbortSignal): Promise<GameView> {
    const created = await this.request<GameCreated>("POST", "/games", { body: request, signal });
    this.secrets.set(created.view.state.game_id, created.host_secret);
    return created.view;
  }

  /**
   * Take a free seat in a game this browser is only watching (ADR-012, MON-906).
   *
   * The secret comes back once and is stored here. The view comes back with it, already filtered to
   * the claimed seat, so the joiner's next render is the one they play from rather than an empty
   * action bar waiting on a refetch.
   */
  async claimSeat(gameId: string, player: number, signal?: AbortSignal): Promise<GameView> {
    const claimed = await this.request<SeatClaimed>(
      "POST",
      `/games/${encodeURIComponent(gameId)}/seats/${String(player)}/claim`,
      { signal },
    );
    this.secrets.set(gameId, claimed.seat_secret);
    return claimed.view;
  }

  /** Void a seat's claim so somebody can take it again. Host only, and idempotent. */
  async releaseSeat(gameId: string, player: number, signal?: AbortSignal): Promise<void> {
    await this.request<null>(
      "DELETE",
      `/games/${encodeURIComponent(gameId)}/seats/${String(player)}/claim`,
      { signal },
    );
  }

  /**
   * The current view, optionally replaying the events after `since` (G-34).
   *
   * `since` is omitted for state only and passed as `0` to replay the whole game, which is
   * what a client that has just connected wants. It is a *cursor*, not a page number: the
   * caller holds it, because the caller is what knows which events it has already seen.
   */
  getGame(gameId: string, since?: number, signal?: AbortSignal): Promise<GameView> {
    const query = since === undefined ? "" : `?since=${String(since)}`;
    return this.request<GameView>("GET", `/games/${encodeURIComponent(gameId)}${query}`, {
      signal,
    });
  }

  /**
   * Apply one command. The only way a game changes, and the answer is the new view.
   *
   * The response is the whole projection, which is why nothing in this package patches state
   * optimistically: the engine decided what happened, and a client that guessed first would
   * be holding a rule.
   */
  submitCommand(gameId: string, command: Command, signal?: AbortSignal): Promise<GameView> {
    return this.request<GameView>("POST", `/games/${encodeURIComponent(gameId)}/commands`, {
      body: { command },
      signal,
    });
  }

  /**
   * Ask whether a command would be accepted, changing nothing (G-32).
   *
   * An illegal command is a 200 with `legal: false`, not a 422 — "not valid yet" is the
   * normal answer while a trade draft is half-built, not an error.
   */
  validateCommand(gameId: string, command: Command, signal?: AbortSignal): Promise<LegalityView> {
    return this.request<LegalityView>("POST", `/games/${encodeURIComponent(gameId)}/validate`, {
      body: { command },
      signal,
    });
  }

  /**
   * The save file — the only response carrying hidden information (ADR-008 §2).
   *
   * A `SaveFile` since ADR-011: the state *and* the session's log, so a restored game has its
   * history. Nothing above this reads inside it; `SaveGameButton` names the file from
   * `state.game_id` and `state.turn_number` and posts the rest back untouched.
   */
  saveGame(gameId: string, signal?: AbortSignal): Promise<SaveFile> {
    return this.request<SaveFile>("GET", `/games/${encodeURIComponent(gameId)}/save`, { signal });
  }

  /**
   * Restore a saved game. The body is exactly what {@link saveGame} returned (MON-704).
   *
   * The parameter is typed `unknown` rather than `GameState`, and that is the interesting decision
   * here. A save arrives from a *file the player chose*, so at the moment it is posted nothing has
   * established that it is a `GameState` — typing the parameter as one would mean a cast at every
   * call site, which is a compiler-silencing assertion about a stranger's JSON. The server
   * validates it against the real model and answers `error.save_schema_mismatch` when it is not
   * one, which is the only place that check can be trusted: a client-side validator would be a
   * second opinion about the engine's schema, and the version it disagreed with would be its own.
   *
   * The answer is an ordinary `GameView`, so a restored game reaches the UI exactly as a new one
   * does and nothing downstream has a "was this loaded" branch in it.
   *
   * `ifExists` is the player's answer to a 409 they have already been shown (ADR-011, MON-714), so
   * it is *omitted* on a first attempt: the server's default is `refuse`, and a client that sent
   * `replace` before anybody had been asked would be ending a game on its own initiative.
   */
  async loadGame(save: unknown, ifExists?: IfExists, signal?: AbortSignal): Promise<GameView> {
    const query = ifExists === undefined ? "" : `?if_exists=${encodeURIComponent(ifExists)}`;
    /*
      The credential for the game this save is *about* (ADR-012).

      `if_exists=replace` ends whatever session currently holds that id, so the server asks for that
      session's host secret — and `/games/load` carries no id in its path for `gameOf` to find one
      by. The id is inside the body, which this client already reads for one other purpose
      (`SaveGameButton` names the file from it), so it is read here too and used to look the secret
      up. A `refuse` or a `copy` needs nothing, but sending it costs nothing either: the header is
      only consulted on the branch that ends a game.
    */
    const replacing = gameIdInSave(save);
    const held = replacing === undefined ? undefined : this.secrets.get(replacing);
    // A `GameCreated`, exactly as `createGame` gets: a restored game is a *new* session with a new
    // authority, so its loader is the one who has to be handed the host secret (ADR-012). Without
    // this, loading a save would lock the loader out of the game they had just restored.
    const restored = await this.request<GameCreated>("POST", `/games/load${query}`, {
      body: save,
      signal,
      secret: held,
    });
    this.secrets.set(restored.view.state.game_id, restored.host_secret);
    return restored.view;
  }

  async deleteGame(gameId: string, signal?: AbortSignal): Promise<void> {
    await this.request<null>("DELETE", `/games/${encodeURIComponent(gameId)}`, { signal });
  }

  // --- The event stream ---------------------------------------------------

  /**
   * The WebSocket URL for this game's event stream, replaying from `since`.
   *
   * Built rather than configured, and the one line does both cases. `new URL(path, base)` resolves
   * a *relative* `baseUrl` against the page — the same-origin default — and lets an *absolute* one
   * win outright, which is what a split deployment needs (MON-901). The scheme then follows whatever
   * won: an https page, or an https `VITE_API_URL`, so neither can silently open an unencrypted
   * socket.
   */
  eventStreamUrl(gameId: string, since = 0): string {
    const base = this.origin ?? globalThis.location.href;
    const url = new URL(`${this.baseUrl}/games/${encodeURIComponent(gameId)}/ws`, base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("since", String(since));
    return url.toString();
  }

  openEventStream(gameId: string, since = 0): SocketLike {
    return this.makeSocket(this.eventStreamUrl(gameId, since));
  }

  // --- Transport ----------------------------------------------------------

  /**
   * The game this path is about, for picking the right credential — or `undefined`.
   *
   * Read off the path rather than threaded through every method, so that a route added later cannot
   * forget to present the secret. `/games/load` is deliberately not a game id: the load's own
   * authority question is about the game *inside the body*, and the server resolves that from the
   * `Authorization` header against the session it is replacing. That header is added below by the
   * dedicated branch, because at this point there is no id to look one up by.
   */
  private gameOf(path: string): string | undefined {
    const found = /^\/games\/([^/?]+)/.exec(path);
    const id = found?.[1];
    return id === undefined || id === "load" ? undefined : decodeURIComponent(id);
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; signal?: AbortSignal | undefined; secret?: string | undefined },
  ): Promise<T> {
    const init: RequestInit = { method };
    const headers: Record<string, string> = {};
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
      headers["content-type"] = "application/json";
    }
    const gameId = this.gameOf(path);
    const secret = options.secret ?? (gameId === undefined ? undefined : this.secrets.get(gameId));
    if (secret !== undefined) {
      // `Bearer`, and only when one is held: sending an empty credential is not the same request as
      // sending none, and "none" is what an unclaimed spectator is (ADR-012).
      headers["authorization"] = `Bearer ${secret}`;
    }
    if (Object.keys(headers).length > 0) {
      init.headers = headers;
    }
    if (options.signal !== undefined) {
      init.signal = options.signal;
    }

    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      // A rejected `fetch` is a network failure, an abort, or a CORS refusal. None of them
      // carry an i18n key, and the browser's `message` is developer English.
      throw asApiError(cause);
    }

    if (!response.ok) {
      throw await toApiError(response);
    }
    if (response.status === NO_CONTENT) {
      return null as T;
    }
    try {
      return (await response.json()) as T;
    } catch {
      // A 200 whose body is not JSON is a broken transport, not a rejected command. The
      // status is kept: "the server answered 200 with rubbish" is a different diagnosis from
      // "nothing answered", even though both say `error.network` to the player.
      throw new ApiError(response.status, TRANSPORT_ERROR_KEY);
    }
  }
}

/**
 * The `game_id` inside a save file, or `undefined` when the payload is not one (ADR-012).
 *
 * Both shapes ADR-011 accepts: the `SaveFile` envelope, and the bare `GameState` that every file
 * written before it is. Structural rather than typed, because the parameter is a *file the player
 * chose* and nothing has established what it is — the same reasoning `loadGame` gives for taking
 * `unknown`, and the same read `local/mode.ts` makes for the reload slot.
 *
 * This is the one field of a save this package reads, and it reads it to look up a credential
 * rather than to learn anything about the game.
 */
function gameIdInSave(save: unknown): string | undefined {
  if (typeof save !== "object" || save === null) {
    return undefined;
  }
  const envelope = save as { game_id?: unknown; state?: { game_id?: unknown } };
  const id = envelope.state?.game_id ?? envelope.game_id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * Read a failed response's `{reason_key, params}` body into a typed error.
 *
 * Every status the server declares — 404, 409, 413, 422, 503 and the keyed 500 — carries this
 * shape, so there is one parser rather than a branch per status. A body that is *not* the
 * declared shape (a proxy's HTML error page, say) becomes the transport key: inventing a
 * plausible reason for a response we did not understand would be worse than admitting we
 * did not.
 */
async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new ApiError(response.status, TRANSPORT_ERROR_KEY);
  }
  if (isErrorResponse(body)) {
    return new ApiError(response.status, body.reason_key, toErrorParams(body.params));
  }
  return new ApiError(response.status, TRANSPORT_ERROR_KEY);
}
