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
    createGame: (requestJson) =>
      record("createGame", [requestJson], () =>
        envelope(201, { state: { game_id: "g1" }, event_cursor: 0 }),
      ),
    listGames: () => record("listGames", [], () => envelope(200, [])),
    loadGame: (stateJson) =>
      record("loadGame", [stateJson], () =>
        envelope(201, { state: { game_id: "g1" }, event_cursor: 0 }),
      ),
    getGame: (gameId, since) =>
      record("getGame", [gameId, since], () =>
        envelope(200, { state: { game_id: gameId }, event_cursor: cursor() }),
      ),
    saveGame: (gameId) =>
      record("saveGame", [gameId], () => envelope(200, { game_id: gameId, rng: { seed: 1 } })),
    submitCommand: (gameId, requestJson) =>
      record("submitCommand", [gameId, requestJson], () =>
        envelope(200, { state: { game_id: gameId }, event_cursor: cursor() }),
      ),
    validateCommand: (gameId, requestJson) =>
      record("validateCommand", [gameId, requestJson], () =>
        envelope(200, { legal: true, params: {} }),
      ),
    deleteGame: (gameId) => record("deleteGame", [gameId], () => envelope(204, null)),

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
