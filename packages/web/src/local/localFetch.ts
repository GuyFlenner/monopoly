/**
 * A `fetch` that answers from the rules engine in this tab instead of from a server.
 *
 * `ApiClient` takes its `fetch` as a constructor option (see `api/client.ts`), so this is the only
 * thing the local build has to substitute in order to have a working transport: the client's URLs,
 * its `{reason_key, params}` error parsing, its 204 handling and its generated types all stay
 * exactly as they are. Nothing above this file knows which build it is running in.
 *
 * ## What it is allowed to do
 *
 * Match a path, hand the body to the Python facade, and turn the `{status, body}` envelope that
 * comes back into a real `Response`. That is the complete list. In particular:
 *
 * * **It never inspects a game.** The one field it reads out of a body is `state.game_id`, and
 *   only to say *which* game a bot pump should be started for. It does not read a phase, a legal
 *   command, or a cash figure, because the moment it does there is a rule on this side of the wire.
 *   Every `POST /games` and `POST /games/load` response is already carrying the id in the response
 *   the caller asked for; reading it here saves the caller from being told about the pump.
 * * **It never invents a status.** A refusal is the facade's status and the facade's keyed body,
 *   verbatim, so `client.ts` produces the identical `ApiError` it would have produced against the
 *   server. `packages/server/tests/test_browser_parity.py` is what makes that worth relying on.
 * * **An unrouted path is a keyed 404, and a wrong method a keyed 405**, mirroring
 *   `api._http_exception_handler` — a shape the generated client can branch on rather than the
 *   `{"detail": ...}` starlette used to answer with (G-33).
 */

import type { FetchLike } from "@/api";

import { parseEnvelope, type Envelope, type PyBridge } from "./bridge";
import { gameIdOfPlainGet } from "./rehydrate";

/** The prefix `ApiClient` puts in front of every path. `DEFAULT_BASE_URL` in `client.ts`. */
export const DEFAULT_LOCAL_BASE_PATH = "/api";

/**
 * Only used to resolve the relative URLs `ApiClient` builds. Never fetched, never displayed — a
 * `URL` constructor needs *some* base, and the page's own origin would make the parsing depend on
 * where the site is deployed.
 */
const RESOLUTION_ORIGIN = "http://local.invalid";

const NO_CONTENT = 204;
const NOT_FOUND = 404;
const METHOD_NOT_ALLOWED = 405;

export interface LocalFetchOptions {
  readonly basePath?: string;
  /**
   * Called with the game id after a request that may have handed the table to a computer.
   *
   * Creating a game, loading one and applying a command are the three, and they are the same three
   * points at which `api.py` queues `_advance_bots`. Fired and not awaited: the response is the
   * caller's own move and must not wait for the bots, which is the whole of MON-304.
   */
  readonly onMutation?: (gameId: string) => void;
  /**
   * Asked when a plain `GET /games/{id}` answers 404, before the caller is told.
   *
   * Returning `true` means "the game is there now, ask again" — which is how the local build
   * survives a reload without anything above this directory learning that its session lives in a
   * heap that a refresh discards (ADR-010). Absent, a 404 is a 404, which is what the server build
   * wants and what every existing test of this file expects.
   */
  readonly onMissingGame?: (gameId: string) => Promise<boolean>;
}

/** One matched route: the facade call to make, and the game it concerns. */
interface Route {
  readonly answer: () => Promise<string>;
  /** Set when this route may have handed the table to a bot. See {@link LocalFetchOptions}. */
  readonly mutates?: "known" | "in-response";
  readonly gameId?: string;
}

const GAME = /^\/games\/([^/]+)$/;
const GAME_COMMANDS = /^\/games\/([^/]+)\/commands$/;
const GAME_VALIDATE = /^\/games\/([^/]+)\/validate$/;
const GAME_SAVE = /^\/games\/([^/]+)\/save$/;

export function createLocalFetch(bridge: PyBridge, options: LocalFetchOptions = {}): FetchLike {
  const basePath = (options.basePath ?? DEFAULT_LOCAL_BASE_PATH).replace(/\/$/, "");

  return async function localFetch(input: string, init?: RequestInit): Promise<Response> {
    // `fetch` rejects an already-aborted request rather than performing it, and TanStack Query
    // relies on that to discard a query it no longer wants. Nothing below is cancellable — a
    // Python call in progress runs to completion — so the signal is honoured at the edges only,
    // which is enough: the answer to an abandoned request is thrown away either way.
    const signal = init?.signal;
    throwIfAborted(signal);

    const method = (init?.method ?? "GET").toUpperCase();
    const url = new URL(input, RESOLUTION_ORIGIN);
    const path = url.pathname.startsWith(basePath)
      ? url.pathname.slice(basePath.length)
      : url.pathname;
    const body = typeof init?.body === "string" ? init.body : "";

    const route = match(bridge, method, path, url, body);
    if (route === null) {
      return respond(unrouted(path));
    }

    let envelope = parseEnvelope(await route.answer());
    throwIfAborted(signal);

    /*
      The reload, rescued (ADR-010).

      A session in this build is Python objects in this tab's heap, so after a reload the store has
      never heard of the game the URL names and answers a truthful 404. `onMissingGame` is given the
      chance to put it back — from a `localStorage` snapshot in the real wiring — and the request is
      asked again exactly once. Once, because a restore that did not work will not work on the
      retry either, and a 404 that keeps retrying is a poll that never settles.

      The route is re-run rather than the response faked: whatever `getGame` answers after the load
      is the engine's own answer, including the `?since=` cursor handling this file knows nothing
      about.
    */
    const missing = options.onMissingGame;
    if (envelope.status === NOT_FOUND && missing !== undefined) {
      const gameId = gameIdOfPlainGet(method, path);
      if (gameId !== null && (await missing(gameId))) {
        throwIfAborted(signal);
        envelope = parseEnvelope(await route.answer());
        throwIfAborted(signal);
      }
    }
    if (route.mutates !== undefined && envelope.status >= 200 && envelope.status < 300) {
      const gameId = route.mutates === "known" ? route.gameId : gameIdIn(envelope.body);
      if (gameId !== undefined) {
        options.onMutation?.(gameId);
      }
    }
    return respond(envelope);
  };
}

function match(
  bridge: PyBridge,
  method: string,
  path: string,
  url: URL,
  body: string,
): Route | null {
  if (path === "/boards") {
    return method === "GET" ? { answer: () => bridge.listBoards() } : null;
  }
  if (path === "/rulesets") {
    return method === "GET" ? { answer: () => bridge.listRulesets() } : null;
  }
  if (path === "/games") {
    if (method === "GET") {
      return { answer: () => bridge.listGames() };
    }
    return method === "POST"
      ? { answer: () => bridge.createGame(body), mutates: "in-response" }
      : null;
  }
  if (path === "/games/load" && method === "POST") {
    // Forwarded as text, present-or-absent, exactly as `?since=` is below: the facade validates it
    // the way FastAPI's enum does, so a typo is the same `error.malformed_request` in both builds
    // rather than a policy this side quietly picked (ADR-011).
    const ifExists = url.searchParams.get("if_exists");
    return { answer: () => bridge.loadGame(body, ifExists), mutates: "in-response" };
  }
  // Any other verb on `/games/load` deliberately falls through to `/games/{id}` below, because
  // that is what starlette does: `GET /games/load` is a full match for the parameterised route and
  // therefore an `error.game_not_found` 404, not a 405.

  const commands = GAME_COMMANDS.exec(path);
  if (commands !== null) {
    const gameId = decode(commands[1]);
    return method === "POST"
      ? { answer: () => bridge.submitCommand(gameId, body), mutates: "known", gameId }
      : null;
  }

  const validate = GAME_VALIDATE.exec(path);
  if (validate !== null) {
    const gameId = decode(validate[1]);
    return method === "POST" ? { answer: () => bridge.validateCommand(gameId, body) } : null;
  }

  const save = GAME_SAVE.exec(path);
  if (save !== null) {
    const gameId = decode(save[1]);
    return method === "GET" ? { answer: () => bridge.saveGame(gameId) } : null;
  }

  const game = GAME.exec(path);
  if (game !== null) {
    const gameId = decode(game[1]);
    if (method === "GET") {
      // Forwarded as text, present-or-absent, because `?since=` is a cursor the facade validates:
      // omitted means state only and `0` replays the whole game, and those are different answers.
      const since = url.searchParams.get("since");
      return { answer: () => bridge.getGame(gameId, since) };
    }
    return method === "DELETE" ? { answer: () => bridge.deleteGame(gameId) } : null;
  }

  return null;
}

/**
 * A path no route matched, or a method no route accepts, in this API's one error shape.
 *
 * The distinction between the two is kept — 405 for a known path with the wrong verb — because it
 * is the distinction starlette makes and therefore the one the parity the rest of this file
 * maintains is measured against.
 */
function unrouted(path: string): Envelope {
  const known =
    [GAME, GAME_COMMANDS, GAME_VALIDATE, GAME_SAVE].some((pattern) => pattern.test(path)) ||
    ["/boards", "/rulesets", "/games"].includes(path);
  const status = known ? METHOD_NOT_ALLOWED : NOT_FOUND;
  const reason_key = known ? "error.method_not_allowed" : "error.not_found";
  // `params: {status}` and nothing else, because that is exactly what
  // `api._http_exception_handler` sends: one catalogue entry covers every status through that param,
  // and an extra one here would be a key the Hebrew catalogue does not carry a placeholder for.
  return { status, body: { reason_key, params: { status } } };
}

/**
 * One envelope as the `Response` `ApiClient` expects.
 *
 * A 204 must carry a null body — the `Response` constructor throws on a body with a null-body
 * status, which would turn a successful delete into a `TypeError` the client reports as
 * `error.network`.
 */
function respond(envelope: Envelope): Response {
  const isNullBody = envelope.status === NO_CONTENT || envelope.body === null;
  return new Response(isNullBody ? null : JSON.stringify(envelope.body), {
    status: envelope.status,
    headers: { "content-type": "application/json" },
  });
}

/** The game a creation or a load answered with. `undefined` when the body is not a view. */
function gameIdIn(body: unknown): string | undefined {
  const state = (body as { state?: { game_id?: unknown } } | null)?.state;
  return typeof state?.game_id === "string" ? state.game_id : undefined;
}

/**
 * A path segment as the game id `encodeURIComponent` made it.
 *
 * An undecodable segment — a lone `%` — is passed through raw rather than refused, so the facade
 * answers the ordinary `error.game_not_found` for it. `decodeURIComponent`'s `URIError` escaping
 * this function would leave the caller with a rejected promise carrying no key at all.
 */
function decode(segment: string | undefined): string {
  if (segment === undefined) {
    return "";
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted.", "AbortError");
  }
}
