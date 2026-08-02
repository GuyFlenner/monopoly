/**
 * Whether a purchase ends the turn by itself, remembered between sessions.
 *
 * A deliberate copy of `sound/mute.ts`, which is itself a deliberate copy of `board/motion.ts`. The
 * three things those two worked out and wrote down hold here unchanged, so they are cited rather than
 * re-argued:
 *
 * 1. **The live value is in memory; `localStorage` is only where it is persisted.** Private browsing
 *    throws on `setItem`, and a snapshot that read straight from storage would silently discard the
 *    player's choice — the switch would appear not to work.
 * 2. **A module-level store, not React state**, so two copies of the switch cannot disagree.
 * 3. **A `storage` event drops the cached value**, so a second tab is the same player changing their
 *    mind rather than two tabs fighting over a boolean.
 *
 * ## The default is ON
 *
 * The owner asked for the behaviour, so the behaviour is what a player who has never opened the
 * chrome gets. The switch exists because "the pause before the next player rolls" is a real
 * preference — a table that likes to look at the board between turns should not have to fight the
 * feature — and because a default nobody can turn off is not a default, it is a decision taken on
 * somebody else's behalf.
 *
 * Read as `!== "false"` rather than `=== "true"`, which is the mirror image of the spelling `mute.ts`
 * argues for: an absent key and a corrupt value must both mean the default, and with a default of
 * `true` this is the spelling that gives that.
 */

import { useCallback, useSyncExternalStore } from "react";

/** Where the choice is remembered. Namespaced like `MUTE_STORAGE_KEY`, for the same reason. */
export const AUTO_END_TURN_STORAGE_KEY = "kesef-street:auto-end-turn";

/** On. See the module docstring. */
export const DEFAULT_AUTO_END_TURN = true;

const listeners = new Set<() => void>();
let cachedChoice: boolean | null = null;

function notify(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

/**
 * Forget the cached value so the next read comes from disk.
 *
 * Exported for the tests, which write `localStorage` directly to assert that a choice made in a
 * previous session is honoured — and would otherwise read a boolean this module cached during an
 * earlier test in the same process.
 */
export function forgetCachedAutoEndTurn(): void {
  cachedChoice = null;
  notify();
}

// Registered once for the module's life rather than per subscriber: the cached value has to be dropped
// whether or not a component happens to be mounted when the other tab writes.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event: StorageEvent) => {
    // A `null` key means storage was cleared wholesale, which includes ours.
    if (event.key === null || event.key === AUTO_END_TURN_STORAGE_KEY) {
      forgetCachedAutoEndTurn();
    }
  });
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function readAutoEndTurn(): boolean {
  if (cachedChoice !== null) {
    return cachedChoice;
  }
  try {
    const stored = globalThis.localStorage.getItem(AUTO_END_TURN_STORAGE_KEY);
    cachedChoice = stored === null ? DEFAULT_AUTO_END_TURN : stored !== "false";
  } catch {
    // No storage at all, or a private mode that refuses to be read. Either way, the default.
    cachedChoice = DEFAULT_AUTO_END_TURN;
  }
  return cachedChoice;
}

export function writeAutoEndTurn(next: boolean): void {
  cachedChoice = next;
  try {
    globalThis.localStorage.setItem(AUTO_END_TURN_STORAGE_KEY, next ? "true" : "false");
  } catch {
    // The choice cannot be remembered past this page, which is a shame and not a failure. It has
    // already taken effect in memory, so the switch the player just pressed still works.
  }
  notify();
}

export interface AutoEndTurnPreference {
  readonly autoEndTurn: boolean;
  readonly setAutoEndTurn: (next: boolean) => void;
  readonly toggle: () => void;
}

export function useAutoEndTurnPreference(): AutoEndTurnPreference {
  const autoEndTurn = useSyncExternalStore(subscribe, readAutoEndTurn, () => DEFAULT_AUTO_END_TURN);

  const setAutoEndTurn = useCallback((next: boolean) => {
    writeAutoEndTurn(next);
  }, []);
  const toggle = useCallback(() => {
    // Read through the store rather than closing over the value: two switches in different subtrees
    // must both flip the *current* value, not the one their render saw.
    writeAutoEndTurn(!readAutoEndTurn());
  }, []);

  return { autoEndTurn, setAutoEndTurn, toggle };
}
