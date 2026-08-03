/**
 * Surviving a reload in the build whose server is this tab (ADR-010).
 *
 * ## The falsifier
 *
 * The bug was not visible to any unit test, and a unit test written carelessly would not see it
 * now: a fake bridge that remembers games across a "reload" is a fake that does not have the
 * problem. So the fixture below models the thing that actually happens — **the engine forgets** —
 * with a bridge whose store can be emptied, exactly as a new Pyodide heap is empty. `forget()` is
 * the reload.
 *
 * Everything else here is about the file refusing to be trusted: a slot that throws on write, a
 * slot holding a save for a *different* game, an engine that refuses the payload, and a half-written
 * slot. In every one of them the game in the tab must keep working and the caller must get the
 * honest answer.
 */

import { describe, expect, it, vi } from "vitest";

import {
  browserSaveSlot,
  gameIdOfPlainGet,
  LOCAL_SAVE_KEY,
  restoreGame,
  savedGameId,
  snapshotGame,
  type SaveSlot,
} from "./rehydrate";
import { parseEnvelope, type PyBridge } from "./bridge";

/** A slot backed by a variable, so a test can see what was written without a DOM. */
function memorySlot(initial: string | null = null): SaveSlot & { value: string | null } {
  const slot = {
    value: initial,
    read: () => slot.value,
    write: (payload: string) => {
      slot.value = payload;
    },
    clear: () => {
      slot.value = null;
    },
  };
  return slot;
}

function envelope(status: number, body: unknown): string {
  return JSON.stringify({ status, body });
}

/**
 * A bridge that holds games and can be made to forget them.
 *
 * Only the three calls this file makes are real; everything else throws, so a change that made this
 * module reach for another facade call would fail loudly rather than silently widening its remit.
 */
function bridgeWith(games: Record<string, unknown>): PyBridge & {
  forget: () => void;
  loads: number;
  saves: number;
} {
  const held = new Map(Object.entries(games));
  const fake = {
    held,
    loads: 0,
    saves: 0,
    forget: () => {
      held.clear();
    },
    saveGame: (gameId: string) => {
      fake.saves += 1;
      const state = held.get(gameId);
      return Promise.resolve(
        state === undefined
          ? envelope(404, { reason_key: "error.game_not_found", params: {} })
          : envelope(200, state),
      );
    },
    loadGame: (stateJson: string) => {
      fake.loads += 1;
      const state = JSON.parse(stateJson) as { game_id: string };
      held.set(state.game_id, state);
      return Promise.resolve(envelope(201, state));
    },
    getGame: (gameId: string) =>
      Promise.resolve(
        held.has(gameId)
          ? envelope(200, held.get(gameId))
          : envelope(404, { reason_key: "error.game_not_found", params: {} }),
      ),
  } as unknown as PyBridge & { forget: () => void; loads: number; saves: number };
  return fake;
}

describe("which request a restore can rescue", () => {
  it("is a plain read of one game, and nothing else", () => {
    expect(gameIdOfPlainGet("GET", "/games/g1")).toBe("g1");
    // A save, a command and a validate all name a game too, and none of them is a request whose
    // 404 means "this tab was reloaded" — the first would restore in order to answer a download,
    // and the other two are mutations that must not be silently applied to a resurrected game.
    expect(gameIdOfPlainGet("GET", "/games/g1/save")).toBeNull();
    expect(gameIdOfPlainGet("POST", "/games/g1/commands")).toBeNull();
    expect(gameIdOfPlainGet("DELETE", "/games/g1")).toBeNull();
    expect(gameIdOfPlainGet("GET", "/boards")).toBeNull();
  });
});

describe("reading the slot", () => {
  it("finds the game a save is about", () => {
    expect(savedGameId(JSON.stringify({ game_id: "g7", players: [] }))).toBe("g7");
  });

  it("treats an empty, a torn or a nonsense slot as nothing", () => {
    // A tab closed mid-write leaves the second of these, and it must not throw on the next load.
    expect(savedGameId(null)).toBeNull();
    expect(savedGameId('{"game_id": "g7", "play')).toBeNull();
    expect(savedGameId("[]")).toBeNull();
    expect(savedGameId(JSON.stringify({ game_id: 42 }))).toBeNull();
    expect(savedGameId(JSON.stringify({ game_id: "" }))).toBeNull();
  });
});

describe("the snapshot", () => {
  it("writes the engine's own save payload", async () => {
    const bridge = bridgeWith({ g1: { game_id: "g1", turn_number: 4 } });
    const slot = memorySlot();

    await snapshotGame(bridge, "g1", slot);

    expect(JSON.parse(slot.value ?? "null")).toEqual({ game_id: "g1", turn_number: 4 });
  });

  it("empties the slot for a game the engine no longer has", async () => {
    // Leaving a game is one click. The slot must not keep offering to restore it afterwards.
    const bridge = bridgeWith({});
    const slot = memorySlot(JSON.stringify({ game_id: "gone" }));

    await snapshotGame(bridge, "gone", slot);

    expect(slot.value).toBeNull();
  });

  it("cannot break a working game by failing to write", async () => {
    // Private mode. `setItem` throws, the insurance is lost, and the game carries on.
    const bridge = bridgeWith({ g1: { game_id: "g1" } });
    const exploding: SaveSlot = {
      read: () => null,
      write: () => {
        throw new Error("quota exceeded");
      },
      clear: () => undefined,
    };

    await expect(snapshotGame(bridge, "g1", exploding)).resolves.toBeUndefined();
  });

  it("cannot break a working game by the bridge failing", async () => {
    const broken = {
      saveGame: () => Promise.reject(new Error("interpreter is busy")),
    } as unknown as PyBridge;

    await expect(snapshotGame(broken, "g1", memorySlot())).resolves.toBeUndefined();
  });
});

describe("the restore", () => {
  it("puts the game back after the engine has forgotten it — the reload", async () => {
    const bridge = bridgeWith({ g1: { game_id: "g1", turn_number: 9 } });
    const slot = memorySlot();
    await snapshotGame(bridge, "g1", slot);

    // The reload: a new heap, and a store that has never heard of this game.
    bridge.forget();
    expect(parseEnvelope(await bridge.getGame("g1", null)).status).toBe(404);

    expect(await restoreGame(bridge, "g1", slot)).toBe(true);
    const answer = parseEnvelope(await bridge.getGame("g1", null));
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ game_id: "g1", turn_number: 9 });
  });

  it("refuses to answer for a different game", async () => {
    // The stale slot. Without the id check, opening a link to somebody else's game id would restore
    // *this* tab's last game under that name — a game the player never asked for, wearing the right
    // URL, which is worse than the 404 it replaced.
    const bridge = bridgeWith({});
    const slot = memorySlot(JSON.stringify({ game_id: "yesterday" }));

    expect(await restoreGame(bridge, "today", slot)).toBe(false);
    expect(bridge.loads).toBe(0);
  });

  it("says no, and forgets the save, when the engine refuses it", async () => {
    // MON-704's case: a save written by an older `SCHEMA_VERSION`. Keeping it would re-attempt the
    // same refused load on every poll for the rest of the session.
    const refusing = {
      loadGame: () =>
        Promise.resolve(envelope(422, { reason_key: "error.save_schema_mismatch", params: {} })),
    } as unknown as PyBridge;
    const slot = memorySlot(JSON.stringify({ game_id: "g1" }));

    expect(await restoreGame(refusing, "g1", slot)).toBe(false);
    expect(slot.value).toBeNull();
  });

  it("says no when there is nothing stored at all", async () => {
    const bridge = bridgeWith({});
    expect(await restoreGame(bridge, "g1", memorySlot())).toBe(false);
    expect(bridge.loads).toBe(0);
  });
});

describe("the browser slot", () => {
  it("round-trips through localStorage under a namespaced key", () => {
    const slot = browserSaveSlot();
    slot.write('{"game_id":"g1"}');

    expect(globalThis.localStorage.getItem(LOCAL_SAVE_KEY)).toBe('{"game_id":"g1"}');
    expect(slot.read()).toBe('{"game_id":"g1"}');

    slot.clear();
    expect(slot.read()).toBeNull();
  });

  it("answers null rather than throwing when storage refuses to be read", () => {
    vi.spyOn(globalThis.localStorage, "getItem").mockImplementation(() => {
      throw new Error("private mode");
    });
    expect(browserSaveSlot().read()).toBeNull();
    vi.restoreAllMocks();
  });
});
