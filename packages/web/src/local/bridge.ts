/**
 * The contract with the Python side, and the whole of it.
 *
 * `kesef_server.browser` exposes one function per route, each returning a JSON string of
 * `{status, body}` — the status the HTTP transport would have answered with, and the body it
 * would have sent (see that module's docstring for why an envelope rather than a value). This
 * file types those twelve functions and nothing else.
 *
 * **Why an interface rather than a direct call into Pyodide.** Everything in `src/local` except
 * `engine.ts` is written against `PyBridge`, so the route table, the error mapping and the socket
 * pump are all testable against a fake that returns strings. A WebAssembly runtime in the unit
 * gate would make the fast suite slow and the slow suite the only one that runs; the real bridge
 * is exercised by the post-build smoke spec (`e2e-pages/`) instead.
 *
 * Nothing here decides anything about the game. A JSON string comes back and it is handed on.
 */

/** The `{status, body}` envelope every facade function answers with. */
export interface Envelope {
  readonly status: number;
  readonly body: unknown;
}

/**
 * One function per route in `kesef_server.browser`, each answering an {@link Envelope} as text.
 *
 * `since` and `cursor` are passed as they arrived — a query string is a string, and the facade
 * validates it the way FastAPI's `Query(ge=0)` does, so `?since=nonsense` is the same
 * `error.malformed_request` here as it is over HTTP rather than a `NaN` this side invented.
 */
export interface PyBridge {
  listBoards(): Promise<string>;
  listRulesets(): Promise<string>;
  createGame(requestJson: string): Promise<string>;
  listGames(): Promise<string>;
  loadGame(stateJson: string): Promise<string>;
  getGame(gameId: string, since: string | null): Promise<string>;
  saveGame(gameId: string): Promise<string>;
  submitCommand(gameId: string, requestJson: string): Promise<string>;
  validateCommand(gameId: string, requestJson: string): Promise<string>;
  deleteGame(gameId: string): Promise<string>;
  eventsSince(gameId: string, cursor: number): Promise<string>;
  advanceBotsStep(gameId: string): Promise<string>;
}

/**
 * The status used when the facade answered something that is not an envelope at all.
 *
 * A 500 with a body that is *not* `{reason_key, params}` is exactly what `ApiClient` already turns
 * into `error.network` — see `toApiError` in `api/errors.ts`. So a broken bridge reports the same
 * failure a broken server would, rather than a plausible-looking key this file made up.
 */
export const MALFORMED_ENVELOPE_STATUS = 500;

/**
 * Read one answer from the facade.
 *
 * Structural rather than trusting: the Python side is the same repository and the same test suite,
 * but it is also a WebAssembly module loaded over a CDN, and "the runtime failed to load and the
 * call returned undefined" must not surface as a crash inside a React render.
 */
export function parseEnvelope(text: unknown): Envelope {
  if (typeof text !== "string") {
    return { status: MALFORMED_ENVELOPE_STATUS, body: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: MALFORMED_ENVELOPE_STATUS, body: null };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { status: MALFORMED_ENVELOPE_STATUS, body: null };
  }
  const candidate = parsed as { status?: unknown; body?: unknown };
  if (typeof candidate.status !== "number" || !Number.isInteger(candidate.status)) {
    return { status: MALFORMED_ENVELOPE_STATUS, body: null };
  }
  return { status: candidate.status, body: candidate.body ?? null };
}

/** The events a replay or a bot step reports, as the fake socket needs them. */
export interface EventBatch {
  readonly events: readonly unknown[];
  readonly event_cursor: number;
}

/** One bot step's answer: the events it appended, and whether the pump should stop. */
export interface BotStepResult extends EventBatch {
  readonly done: boolean;
}

/**
 * Read an event batch out of an envelope body, or `null` if it is not one.
 *
 * `null` covers both "this was a 404" and "this was something unrecognisable"; the caller closes
 * its socket in either case, because a subscription that will never receive anything is harder to
 * diagnose than one that said why it left.
 */
export function asEventBatch(body: unknown): EventBatch | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const candidate = body as { events?: unknown; event_cursor?: unknown };
  if (!Array.isArray(candidate.events) || typeof candidate.event_cursor !== "number") {
    return null;
  }
  return { events: candidate.events, event_cursor: candidate.event_cursor };
}

/** As {@link asEventBatch}, plus the `done` flag the pump loops on. */
export function asBotStep(body: unknown): BotStepResult | null {
  const batch = asEventBatch(body);
  if (batch === null) {
    return null;
  }
  const done = (body as { done?: unknown }).done;
  if (typeof done !== "boolean") {
    return null;
  }
  return { ...batch, done };
}
