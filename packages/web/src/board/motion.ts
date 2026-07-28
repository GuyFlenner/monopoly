/**
 * Whether to animate, answered in JavaScript.
 *
 * `index.css` already collapses CSS animations under `prefers-reduced-motion`, and that is a floor
 * rather than an answer: an `!important` on `animation-duration` cannot help a duration that
 * JavaScript is choosing, and it cannot help a queue that decides *how long to wait* before
 * committing the next step. So the preference is read here too, at the source, and a skipped
 * animation gets a duration of **zero rather than a different code path** (GAP G-F3).
 *
 * Zero is deliberate. A `0ms` animation still starts, still ends, and still fires `animationend` on
 * the next frame, so "reduced motion" exercises the same code as "full motion" and cannot rot into
 * an untested branch. Nothing waits on it either way — see `DiceTray.tsx`, where the authoritative
 * faces are in the DOM before any of this is consulted (GAP G-F2).
 *
 * ## Two inputs, one answer
 *
 * The operating system's preference and the player's own switch are different facts and are kept
 * apart. A player who has not asked for reduced motion may still want the flourishes off for this
 * game, and one who has asked at the OS level should never have to ask again. The effective answer
 * is the disjunction, and the switch is remembered in `localStorage` because "skippable" is
 * worthless if it has to be re-skipped every turn (GAP G-F1).
 */

import { useCallback, useSyncExternalStore } from "react";

/** Where the player's own switch is remembered. Namespaced; a bare `skip` would collide. */
export const MOTION_STORAGE_KEY = "kesef-street:skip-animations";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function mediaQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY);
}

function subscribeToReducedMotion(onChange: () => void): () => void {
  const query = mediaQuery();
  if (query === null) {
    return () => undefined;
  }
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

function readReducedMotion(): boolean {
  return mediaQuery()?.matches ?? false;
}

/**
 * The operating system's own answer, and it stays current: a player who turns reduced motion on
 * mid-game gets a still board without reloading.
 */
export function useReducedMotion(): boolean {
  // The server snapshot is `false`: prerendering cannot know, and guessing "animate" is the guess
  // that degrades gracefully — the client's first paint corrects it before anything moves.
  return useSyncExternalStore(subscribeToReducedMotion, readReducedMotion, () => false);
}

/**
 * The player's switch.
 *
 * A module-level store rather than React state, so that two toggles — one under the board, one in a
 * settings panel a sibling builds — cannot disagree about whether animation is on.
 *
 * The **live value is in memory** and `localStorage` is where it is *persisted*. That order matters:
 * private browsing modes throw on `setItem`, and if the snapshot read straight from storage then a
 * failed write would silently discard the player's choice — the switch would appear not to work at
 * all, on exactly the devices where accessibility settings matter most. Memory means the choice
 * always takes effect now; storage means it usually survives a reload. A `storage` event from another
 * tab drops the cached value so the next read comes from disk, which is what keeps two tabs in step.
 */
const listeners = new Set<() => void>();
let cachedChoice: boolean | null = null;

function notify(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

function forgetCachedChoice(): void {
  cachedChoice = null;
  notify();
}

// Another tab of the same game counts as the same player changing their mind. Registered once for
// the module's life rather than per subscriber: the cached value has to be dropped whether or not a
// component happens to be mounted at the moment the other tab writes, or the next mount would read a
// stale boolean out of memory and never look at disk again.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event: StorageEvent) => {
    // A `null` key means storage was cleared wholesale, which includes our key.
    if (event.key === null || event.key === MOTION_STORAGE_KEY) {
      forgetCachedChoice();
    }
  });
}

function subscribeToChoice(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function readChoice(): boolean {
  if (cachedChoice !== null) {
    return cachedChoice;
  }
  try {
    cachedChoice = globalThis.localStorage.getItem(MOTION_STORAGE_KEY) === "true";
  } catch {
    // No storage at all, or a private mode that refuses to be read. Either way, not skipping.
    cachedChoice = false;
  }
  return cachedChoice;
}

function writeChoice(next: boolean): void {
  cachedChoice = next;
  try {
    globalThis.localStorage.setItem(MOTION_STORAGE_KEY, next ? "true" : "false");
  } catch {
    // The choice cannot be remembered past this page, which is a shame and not a failure. It has
    // already taken effect in memory, so the switch the player just pressed still works.
  }
  notify();
}

export interface MotionPreference {
  /** The effective answer: either input is enough to stop the flourish. */
  readonly skip: boolean;
  /** The operating system's preference alone. */
  readonly reduced: boolean;
  /** The player's switch alone — what the toggle's `aria-pressed` reflects. */
  readonly chosen: boolean;
  readonly setChosen: (next: boolean) => void;
  readonly toggle: () => void;
  /** A duration in ms: the one asked for, or zero. Zero at the source, not a second branch. */
  readonly durationMs: (fullMs: number) => number;
}

export function useMotionPreference(): MotionPreference {
  const reduced = useReducedMotion();
  const chosen = useSyncExternalStore(subscribeToChoice, readChoice, () => false);
  const skip = reduced || chosen;

  const setChosen = useCallback((next: boolean) => {
    writeChoice(next);
  }, []);
  const toggle = useCallback(() => {
    writeChoice(!readChoice());
  }, []);
  const durationMs = useCallback((fullMs: number) => (skip ? 0 : fullMs), [skip]);

  return { skip, reduced, chosen, setChosen, toggle, durationMs };
}
