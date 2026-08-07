/**
 * The one boundary in this package that is not a `PyBridge` (MON-805, ADR-011).
 *
 * Loading Pyodide cannot be unit-tested — it fetches a CPython build from a CDN, which is what
 * `e2e-pages/local-engine.spec.ts` exists for. What *can* be tested, and had to be after it broke a
 * reload, is the argument mapping in `bridgeTo`: the layer that decides how "not given" reaches
 * Python.
 *
 * ## The defect this file was written for
 *
 * Pyodide stopped translating JS `null` to Python `None` — since 0.28 it arrives as a distinct
 * `JsNull` — so `bridge.loadGame(payload, null)` handed the facade an object where `raw is None` is
 * false. `_if_exists` read that as a *typo* and answered `422 error.malformed_request`, which
 * `restoreGame` reported as "the engine refused the save" and turned a reload back into the
 * game-losing bug ADR-010 fixed. Every unit test passed throughout: they drive a *fake* bridge, so
 * the mapping between the bridge and the facade was the one thing none of them exercised.
 *
 * So the assertions below are about **arity**, which is the only thing that distinguishes "omitted"
 * from "explicitly null" once a value has crossed into Python.
 */

import { describe, expect, it } from "vitest";

import { bridgeTo } from "./engine";

/** Every call the facade received, with how many arguments it was actually given. */
interface Call {
  readonly fn: string;
  readonly args: readonly unknown[];
}

function recordingFacade(): { calls: Call[]; facade: Parameters<typeof bridgeTo>[0] } {
  const calls: Call[] = [];
  const record =
    (fn: string) =>
    (...args: unknown[]): string => {
      calls.push({ fn, args });
      return JSON.stringify({ status: 200, body: {} });
    };
  const facade = {
    list_boards: record("list_boards"),
    list_rulesets: record("list_rulesets"),
    create_game: record("create_game"),
    load_game: record("load_game"),
    get_game: record("get_game"),
    save_game: record("save_game"),
    submit_command: record("submit_command"),
    validate_command: record("validate_command"),
    delete_game: record("delete_game"),
    events_since: record("events_since"),
    advance_bots_step: (gameId: string) => Promise.resolve(record("advance_bots_step")(gameId)),
  } as unknown as Parameters<typeof bridgeTo>[0];
  return { calls, facade };
}

describe("the arguments that reach the Python facade", () => {
  it("omits an absent if_exists rather than passing null", async () => {
    // The restore path (`rehydrate.ts`) asks for exactly this: load, with no conflict policy, because
    // there is nothing live to conflict with. Passed as `null`, Pyodide 0.28+ delivers a `JsNull` that
    // Python reads as a bad value — a keyed 422 instead of a restored game.
    const { calls, facade } = recordingFacade();

    await bridgeTo(facade).loadGame('{"state":{}}', null);

    expect(calls).toEqual([{ fn: "load_game", args: ['{"state":{}}'] }]);
  });

  it("passes if_exists through when the player has answered", async () => {
    const { calls, facade } = recordingFacade();

    await bridgeTo(facade).loadGame('{"state":{}}', "replace");

    expect(calls).toEqual([{ fn: "load_game", args: ['{"state":{}}', "replace"] }]);
  });

  it("omits an absent since for the same reason", async () => {
    // `URLSearchParams.get` answers `null` for a query parameter that is not there, and `localFetch`
    // forwards it verbatim. Omitted means "state only" and `0` means "replay the whole game", so the
    // two are different answers and `null` must not become either by accident.
    const { calls, facade } = recordingFacade();
    const bridge = bridgeTo(facade);

    await bridge.getGame("g1", null);
    await bridge.getGame("g1", "0");

    expect(calls).toEqual([
      { fn: "get_game", args: ["g1"] },
      { fn: "get_game", args: ["g1", "0"] },
    ]);
  });
});
