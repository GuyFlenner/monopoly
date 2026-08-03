/**
 * Keeping the game across a reload, in the build whose server is this tab (ADR-010).
 *
 * The published game runs the engine in the browser, so a session is Python objects in the tab's
 * Pyodide heap. Reload and the heap is new: the store answers a truthful 404 for a game it has never
 * heard of, the client renders that refusal correctly, and the family's evening is gone. Measured on
 * the built artifact, the player sees *"this game no longer exists"* — no crash, nothing in the
 * console, just a game that was there a moment ago.
 *
 * The remedy uses machinery that already exists rather than new machinery: `GET /games/{id}/save`
 * and `POST /games/load` are MON-704's file feature, and `onMutation` is the seam MON-805 put in for
 * the bot pump. What is added here is a `localStorage` slot between them.
 *
 * ## Every decision in this file is about not being trusted
 *
 * * **The snapshot is best-effort.** A private-mode browser throws on `setItem`, and a game that is
 *   working must not stop working because it could not be written down. Every failure is swallowed,
 *   the same discipline `sound/mute.ts` and `board/motion.ts` use for preferences.
 * * **The restore is guarded by the id.** A stored save is only ever loaded for the game the caller
 *   actually asked for, so a stale slot from a previous game cannot silently answer for this one.
 * * **A restore is attempted once per request.** If the load fails — a save from an older
 *   `SCHEMA_VERSION`, a truncated write — the original 404 is what the caller gets, which is the
 *   honest answer and the one the UI already renders.
 * * **Nothing here reads a game.** It moves an opaque payload between two facade calls and compares
 *   one id. No phase, no cash, no legal command; the rule in CLAUDE.md holds on this side of the
 *   wire too.
 */

import { parseEnvelope, type PyBridge } from "./bridge";

/** Where the game in play is kept. Namespaced like every other key this app writes. */
export const LOCAL_SAVE_KEY = "kesef-street:local-save";

/** The 2xx band, which is the only thing this file asks about a status. */
function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * The `localStorage` slot, as three functions that cannot throw.
 *
 * An interface rather than direct calls so the tests can drive a store that fails on write, which is
 * the branch that matters and the one a real browser only produces in private mode.
 */
export interface SaveSlot {
  read(): string | null;
  write(payload: string): void;
  clear(): void;
}

export function browserSaveSlot(key: string = LOCAL_SAVE_KEY): SaveSlot {
  return {
    read() {
      try {
        return globalThis.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write(payload) {
      try {
        globalThis.localStorage.setItem(key, payload);
      } catch {
        // Private mode, or a quota. The game continues; only the reload insurance is lost.
      }
    },
    clear() {
      try {
        globalThis.localStorage.removeItem(key);
      } catch {
        // Nothing to do and nothing to report: the slot is already unreadable.
      }
    },
  };
}

/** The `game_id` inside a stored save, or `null` if the slot holds something that is not one. */
export function savedGameId(payload: string | null): string | null {
  if (payload === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const id = (parsed as { game_id?: unknown }).game_id;
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    // A half-written slot from a tab that was closed mid-write. Treated as empty.
    return null;
  }
}

/**
 * Write the current state of `gameId` to the slot.
 *
 * Called after a mutation and again after the bot pump drains, because a snapshot taken when the
 * human moved is a turn stale the moment a computer answers. Fired and not awaited by both callers:
 * the player's own move is already in the response they are waiting for (MON-304), and insurance
 * that delayed the game it insures would be a poor trade.
 */
export async function snapshotGame(
  bridge: PyBridge,
  gameId: string,
  slot: SaveSlot,
): Promise<void> {
  try {
    const envelope = parseEnvelope(await bridge.saveGame(gameId));
    if (!ok(envelope.status) || envelope.body === null) {
      // A game that has just been left, most likely. Nothing to keep, and the old slot is now about
      // a game that no longer exists, so it goes rather than lingering to be restored later.
      slot.clear();
      return;
    }
    slot.write(JSON.stringify(envelope.body));
  } catch {
    // The bridge itself failed. The game in the tab is unaffected; only the insurance is.
  }
}

/**
 * Put `gameId` back into the engine from the slot, if the slot is about that game.
 *
 * Returns whether the caller should try its request again. `false` covers every uninteresting case
 * — an empty slot, a save for a different game, a load the engine refused — and in all of them the
 * caller's original 404 is the right answer.
 */
export async function restoreGame(
  bridge: PyBridge,
  gameId: string,
  slot: SaveSlot,
): Promise<boolean> {
  const payload = slot.read();
  if (savedGameId(payload) !== gameId || payload === null) {
    return false;
  }
  try {
    const envelope = parseEnvelope(await bridge.loadGame(payload));
    if (ok(envelope.status)) {
      return true;
    }
    // The engine refused it — a save written by an older `SCHEMA_VERSION` is the case MON-704
    // names. It will refuse it again on the next request, so the slot is dropped rather than
    // retried on every poll for the rest of the session.
    slot.clear();
    return false;
  } catch {
    return false;
  }
}

/** `GET /games/{id}` and nothing else — the one request a restore can rescue. */
export function gameIdOfPlainGet(method: string, path: string): string | null {
  if (method.toUpperCase() !== "GET") {
    return null;
  }
  const found = /^\/games\/([^/]+)$/.exec(path);
  return found?.[1] ?? null;
}
