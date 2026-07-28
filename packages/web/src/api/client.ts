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
 */

import {
  ApiError,
  asApiError,
  isErrorResponse,
  toErrorParams,
  TRANSPORT_ERROR_KEY,
} from "./errors";
import type {
  BoardSummary,
  Command,
  GameState,
  GameSummary,
  GameView,
  LegalityView,
  NewGameRequest,
  Ruleset,
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
  /** Where the API lives. The Vite dev proxy puts it at `/api`, same-origin as production. */
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly createSocket?: SocketFactory;
  /** Absolute base for resolving the WebSocket URL. Defaults to the document's location. */
  readonly origin?: string;
}

export const DEFAULT_BASE_URL = "/api";

/** 204 has no body, and `response.json()` on an empty body is a `SyntaxError`. */
const NO_CONTENT = 204;

export class ApiClient {
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly makeSocket: SocketFactory;
  private readonly origin: string | undefined;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.makeSocket = options.createSocket ?? ((url) => new WebSocket(url) as SocketLike);
    this.origin = options.origin;
  }

  // --- Meta ---------------------------------------------------------------

  listBoards(signal?: AbortSignal): Promise<BoardSummary[]> {
    return this.request<BoardSummary[]>("GET", "/boards", { signal });
  }

  listRulesets(signal?: AbortSignal): Promise<Ruleset[]> {
    return this.request<Ruleset[]>("GET", "/rulesets", { signal });
  }

  // --- Games --------------------------------------------------------------

  createGame(request: NewGameRequest, signal?: AbortSignal): Promise<GameView> {
    return this.request<GameView>("POST", "/games", { body: request, signal });
  }

  listGames(signal?: AbortSignal): Promise<GameSummary[]> {
    return this.request<GameSummary[]>("GET", "/games", { signal });
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

  /** The save file — the only response carrying hidden information (ADR-008 §2). */
  saveGame(gameId: string, signal?: AbortSignal): Promise<GameState> {
    return this.request<GameState>("GET", `/games/${encodeURIComponent(gameId)}/save`, { signal });
  }

  async deleteGame(gameId: string, signal?: AbortSignal): Promise<void> {
    await this.request<null>("DELETE", `/games/${encodeURIComponent(gameId)}`, { signal });
  }

  // --- The event stream ---------------------------------------------------

  /**
   * The WebSocket URL for this game's event stream, replaying from `since`.
   *
   * Built rather than configured: `baseUrl` is relative in both dev and production, and a
   * `WebSocket` constructor needs an absolute `ws:`/`wss:` URL. The scheme follows the
   * page's, so an https deployment cannot silently open an unencrypted socket.
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

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; signal?: AbortSignal | undefined },
  ): Promise<T> {
    const init: RequestInit = { method };
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
      init.headers = { "content-type": "application/json" };
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
