/**
 * A fake Python side, for the tests of everything above it.
 *
 * `src/local` is written against {@link PyBridge} precisely so that this file can exist: the route
 * table, the envelope handling, the socket and the bot pump are all covered here, in jsdom, in
 * milliseconds. What is *not* covered here is whether `kesef_server.browser` answers the same thing
 * as the HTTP transport — that is a Python question and
 * `packages/server/tests/test_browser_parity.py` is where it is asked. Trying to answer it twice, in
 * two languages, would produce two half-answers.
 *
 * This fake therefore mimics the *shape* of the facade and none of its rules. Its "game" is a list
 * that grows by two entries per bot step. No board, no cash, no legality — a rule in a test fixture
 * is a rule outside the engine like any other.
 */

import type { Envelope, PyBridge } from "./bridge";

/** One call the fake received, for a test to assert the route table forwarded correctly. */
export interface RecordedCall {
  readonly fn: keyof PyBridge;
  readonly args: readonly unknown[];
}

export interface FakeBridgeOptions {
  /** How many bot steps happen before the pump is told `done`. */
  readonly botMoves?: number;
  /** When true, `eventsSince` answers the 404 a deleted game gets. */
  readonly missing?: boolean;
  /** Per-route answers, as the raw envelope text. Anything unset gets a plain 200. */
  readonly answers?: Partial<Record<keyof PyBridge, (args: readonly unknown[]) => string>>;
}

export interface FakeBridge extends PyBridge {
  readonly calls: RecordedCall[];
  /** The fake log every `eventsSince` reads from. Grows as bot steps are taken. */
  readonly log: { seq: number; event: { type: string } }[];
  /** How many `advanceBotsStep` calls have been made. */
  readonly steps: () => number;
}

/** One `{status, body}` envelope, as the facade would have serialized it. */
export function envelope(status: number, body: unknown): string {
  return JSON.stringify({ status, body });
}

const NOT_FOUND = envelope(404, { reason_key: "error.game_not_found", params: { game_id: "g" } });

/**
 * The host secret this fake hands out (ADR-012, MON-906).
 *
 * A constant rather than a random string, because what a test wants to say is "the client stored
 * *the* secret the transport returned" — and a value it can name is what makes that assertable.
 */
export const HOST_SECRET = "fake-host-secret";

/** Prefix for a claimed seat's secret; the seat number is appended. */
export const SEAT_SECRET_PREFIX = "fake-seat-secret-";

export function createFakeBridge(options: FakeBridgeOptions = {}): FakeBridge {
  const calls: RecordedCall[] = [];
  const log: { seq: number; event: { type: string } }[] = [];
  const botMoves = options.botMoves ?? 0;
  let steps = 0;

  function record(
    fn: keyof PyBridge,
    args: readonly unknown[],
    fallback: () => string,
  ): Promise<string> {
    calls.push({ fn, args });
    const override = options.answers?.[fn];
    return Promise.resolve(override === undefined ? fallback() : override(args));
  }

  const cursor = (): number => (log.length === 0 ? 0 : (log[log.length - 1]?.seq ?? 0));

  return {
    calls,
    log,
    steps: () => steps,

    listBoards: () => record("listBoards", [], () => envelope(200, [{ id: "classic" }])),
    listRulesets: () => record("listRulesets", [], () => envelope(200, [{ name: "universal" }])),
    // A `GameCreated` envelope since ADR-012: the view, and the one host secret a session hands
    // out. `HOST_SECRET` is a fixed string so a test can assert the client stored *this* one.
    createGame: (requestJson) =>
      record("createGame", [requestJson], () =>
        envelope(201, {
          host_secret: HOST_SECRET,
          view: { state: { game_id: "g1" }, event_cursor: 0, claims: [] },
        }),
      ),
    loadGame: (saveJson, secret, ifExists) =>
      record("loadGame", [saveJson, secret, ifExists], () =>
        envelope(201, {
          host_secret: HOST_SECRET,
          view: { state: { game_id: "g1" }, event_cursor: 0, claims: [] },
        }),
      ),
    getGame: (gameId, secret, since) =>
      record("getGame", [gameId, secret, since], () =>
        envelope(200, { state: { game_id: gameId }, event_cursor: cursor(), claims: [] }),
      ),
    saveGame: (gameId, secret) =>
      // A `SaveFile` since ADR-011: the state, and the log a restored session has to come back with.
      record("saveGame", [gameId, secret], () =>
        envelope(200, { state: { game_id: gameId, rng: { seed: 1 } }, events: [] }),
      ),
    submitCommand: (gameId, requestJson, secret) =>
      record("submitCommand", [gameId, requestJson, secret], () =>
        envelope(200, { state: { game_id: gameId }, event_cursor: cursor(), claims: [] }),
      ),
    validateCommand: (gameId, requestJson, secret) =>
      record("validateCommand", [gameId, requestJson, secret], () =>
        envelope(200, { legal: true, params: {} }),
      ),
    deleteGame: (gameId, secret) => record("deleteGame", [gameId, secret], () => envelope(204, null)),
    /* The seat routes (ADR-012). `claim` answers a `SeatClaimed`; `release` is a bare 204. */
    claimSeat: (gameId, player) =>
      record("claimSeat", [gameId, player], () =>
        envelope(201, {
          seat_secret: `${SEAT_SECRET_PREFIX}${String(player)}`,
          view: { state: { game_id: gameId }, event_cursor: cursor(), claims: [] },
        }),
      ),
    releaseSeat: (gameId, player, secret) =>
      record("releaseSeat", [gameId, player, secret], () => envelope(204, null)),

    eventsSince: (gameId, from) =>
      record("eventsSince", [gameId, from], () => {
        if (options.missing === true) {
          return NOT_FOUND;
        }
        return envelope(200, {
          events: log.filter((entry) => entry.seq > from),
          event_cursor: cursor(),
        });
      }),

    advanceBotsStep: (gameId) =>
      record("advanceBotsStep", [gameId], () => {
        if (steps >= botMoves) {
          return envelope(200, { done: true, events: [], event_cursor: cursor() });
        }
        steps += 1;
        const appended = [
          { seq: log.length + 1, event: { type: "dice_rolled" } },
          { seq: log.length + 2, event: { type: "token_moved" } },
        ];
        log.push(...appended);
        return envelope(200, { done: false, events: appended, event_cursor: cursor() });
      }),
  };
}

/** The bodies a test asserts against, so a literal is not repeated in three files. */
export const KEYED_404: Envelope = {
  status: 404,
  body: { reason_key: "error.game_not_found", params: { game_id: "g" } },
};
