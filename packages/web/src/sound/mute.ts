/**
 * Whether the game makes a noise, remembered between sessions.
 *
 * A deliberate copy of the shape in `board/motion.ts`, because that file already worked out the
 * three things that are easy to get wrong about a persisted preference and wrote down why:
 *
 * 1. **The live value is in memory; `localStorage` is where it is *persisted*.** Private browsing
 *    modes throw on `setItem`, and a snapshot that read straight from storage would silently
 *    discard the player's choice — the switch would appear not to work at all. Memory means the
 *    choice takes effect now; storage means it usually survives a reload.
 * 2. **A module-level store, not React state.** Two mute buttons — one in the game chrome, one in a
 *    settings sheet a sibling adds — must not be able to disagree about whether the game is muted.
 * 3. **A `storage` event drops the cached value**, so a second tab of the same game is the same
 *    player changing their mind rather than two players fighting over a boolean.
 *
 * The one thing that differs from motion is the default, and it differs for a reason. Reduced
 * motion has an OS-level preference to respect, so the effective answer there is a disjunction of
 * two inputs. There is no "prefers no sound" media query, so this is one input with one default:
 * **unmuted**. A game that ships silent is a game whose sound nobody discovers, and the switch is
 * one press away in the chrome.
 */

import { useCallback, useSyncExternalStore } from "react";

/** Where the choice is remembered. Namespaced like `MOTION_STORAGE_KEY`, for the same reason. */
export const MUTE_STORAGE_KEY = "kesef-street:muted";

/** Unmuted. See the module docstring for why this is not the cautious default it looks like. */
export const DEFAULT_MUTED = false;

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
 * previous session is honoured — and would otherwise be reading a boolean this module cached
 * during an earlier test in the same process.
 */
export function forgetCachedMute(): void {
  cachedChoice = null;
  notify();
}

// Registered once for the module's life rather than per subscriber: the cached value has to be
// dropped whether or not a component happens to be mounted when the other tab writes.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event: StorageEvent) => {
    // A `null` key means storage was cleared wholesale, which includes ours.
    if (event.key === null || event.key === MUTE_STORAGE_KEY) {
      forgetCachedMute();
    }
  });
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * The current choice.
 *
 * Read as `=== "true"` rather than `!== "false"`: an absent key and a corrupt value both have to
 * mean the default, and only one of those two spellings gives that when the default is `false`.
 */
export function readMuted(): boolean {
  if (cachedChoice !== null) {
    return cachedChoice;
  }
  try {
    const stored = globalThis.localStorage.getItem(MUTE_STORAGE_KEY);
    cachedChoice = stored === null ? DEFAULT_MUTED : stored === "true";
  } catch {
    // No storage at all, or a private mode that refuses to be read. Either way, the default.
    cachedChoice = DEFAULT_MUTED;
  }
  return cachedChoice;
}

export function writeMuted(next: boolean): void {
  cachedChoice = next;
  try {
    globalThis.localStorage.setItem(MUTE_STORAGE_KEY, next ? "true" : "false");
  } catch {
    // The choice cannot be remembered past this page, which is a shame and not a failure. It has
    // already taken effect in memory, so the switch the player just pressed still works.
  }
  notify();
}

export interface MutePreference {
  readonly muted: boolean;
  readonly setMuted: (next: boolean) => void;
  readonly toggle: () => void;
}

export function useMutePreference(): MutePreference {
  // The server snapshot is the default: prerendering cannot read `localStorage`, and the client's
  // first paint corrects it before any event has arrived to make a sound.
  const muted = useSyncExternalStore(subscribe, readMuted, () => DEFAULT_MUTED);

  const setMuted = useCallback((next: boolean) => {
    writeMuted(next);
  }, []);
  const toggle = useCallback(() => {
    // Read through the store rather than closing over `muted`: two toggles rendered in different
    // subtrees must both flip the *current* value, not the one their render saw.
    writeMuted(!readMuted());
  }, []);

  return { muted, setMuted, toggle };
}
