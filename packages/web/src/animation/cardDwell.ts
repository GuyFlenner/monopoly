/**
 * How long a drawn card is held up, in seconds, remembered between sessions (MON-719).
 *
 * The third preference in this product, and a deliberate copy of the shape in `board/motion.ts` and
 * `sound/mute.ts` — those two already worked out the three things that are easy to get wrong about a
 * persisted preference and wrote down why: the live value lives in memory (private modes throw on
 * `setItem`), the store is module-level (two controls must not disagree), and a `storage` event drops
 * the cache (a second tab is the same player changing their mind).
 *
 * ## Why it is a setting at all
 *
 * The owner played a game and could not finish reading a Chance card before it went away. The old
 * dwell was **1.8 s**, chosen as 1.5 × the `<Announcer>`'s step so that a sighted reader and a
 * screen-reader user were on one clock. That reasoning was sound and the number was still too small
 * for the audience this game is built for: a card is two sentences of Hebrew or English, and a
 * six-year-old reads them aloud. So the default is now {@link DEFAULT_CARD_SECONDS}, and — because no
 * single number can be right for a six-year-old and for an adult who has read the deck fifty times —
 * the table chooses on the setup screen.
 *
 * ## Why it is a *presentation* preference and not a game setting
 *
 * It never reaches the engine and it is not on the create-game request. How long a card is *shown* is
 * the same kind of fact as whether the game makes a noise: it belongs to the person looking at the
 * screen, not to the game being played, so a save file restored on another device must not carry
 * somebody else's reading speed. It is also why nothing waits for it — see `CardReveal.tsx`: the card
 * can be put down at any moment and no input is gated on it, so a long dwell delays nothing.
 */

import { useCallback, useSyncExternalStore } from "react";

/** Where the choice is remembered. Namespaced like the other two, for the same reason. */
export const CARD_DWELL_STORAGE_KEY = "kesef-street:card-seconds";

/**
 * Five seconds.
 *
 * Comfortably more than the ~1.9 s the `<Announcer>` needs to finish saying a card (its
 * `DEFAULT_STEP_MS` is 1200 ms), which keeps the property the old 1800 ms was chosen for — the
 * card is still on screen when the polite region has finished — while leaving time to *read* it.
 * An upper bound, never a wait.
 */
export const DEFAULT_CARD_SECONDS = 5;

/**
 * The range the setting offers, in seconds.
 *
 * The floor is not 0. A card that can be set to vanish instantly is a card a player can turn off by
 * accident, and MON-709 exists because the sentence was nowhere on screen — "off" is what the skip
 * switch and `prefers-reduced-motion` are for, and both already collapse this to nothing through the
 * queue's own instant path. The ceiling is fifteen: past that a queued second card is waiting behind
 * a card nobody is still reading, and compression starts dropping beats a player asked for.
 */
export const MIN_CARD_SECONDS = 2;
export const MAX_CARD_SECONDS = 15;

const listeners = new Set<() => void>();
let cachedChoice: number | null = null;

function notify(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

/**
 * The value as a number of whole seconds inside the offered range, or `null` for anything else.
 *
 * Exported because the setup screen needs the same answer for the field it renders: a control that
 * accepted a value this module would then reject is a control that appears to work and does not.
 */
export function clampCardSeconds(value: unknown): number | null {
  const seconds = typeof value === "string" ? Number(value) : value;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return null;
  }
  const whole = Math.round(seconds);
  if (whole < MIN_CARD_SECONDS || whole > MAX_CARD_SECONDS) {
    return null;
  }
  return whole;
}

/** Forget the cached value so the next read comes from disk. Exported for the tests. */
export function forgetCachedCardSeconds(): void {
  cachedChoice = null;
  notify();
}

// Registered once for the module's life rather than per subscriber: the cached value has to be
// dropped whether or not a component happens to be mounted when the other tab writes.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event: StorageEvent) => {
    // A `null` key means storage was cleared wholesale, which includes ours.
    if (event.key === null || event.key === CARD_DWELL_STORAGE_KEY) {
      forgetCachedCardSeconds();
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
 * The current choice, in seconds.
 *
 * A stored value out of range — a hand-edited `localStorage`, or a ceiling this build lowered — reads
 * as the default rather than as itself. The alternative is a card that stays up for an hour because a
 * number in storage said so.
 */
export function readCardSeconds(): number {
  if (cachedChoice !== null) {
    return cachedChoice;
  }
  try {
    cachedChoice =
      clampCardSeconds(globalThis.localStorage.getItem(CARD_DWELL_STORAGE_KEY)) ??
      DEFAULT_CARD_SECONDS;
  } catch {
    // No storage at all, or a private mode that refuses to be read. Either way, the default.
    cachedChoice = DEFAULT_CARD_SECONDS;
  }
  return cachedChoice;
}

export function writeCardSeconds(next: number): void {
  const seconds = clampCardSeconds(next) ?? DEFAULT_CARD_SECONDS;
  cachedChoice = seconds;
  try {
    globalThis.localStorage.setItem(CARD_DWELL_STORAGE_KEY, String(seconds));
  } catch {
    // The choice cannot be remembered past this page, which is a shame and not a failure: it has
    // already taken effect in memory, so the control the player just used still works.
  }
  notify();
}

/** The dwell in milliseconds, which is what {@link TimelineDurations.cardMs} wants. */
export function cardDwellMs(seconds: number): number {
  return seconds * 1000;
}

export interface CardDwellPreference {
  readonly seconds: number;
  readonly setSeconds: (next: number) => void;
}

export function useCardDwellPreference(): CardDwellPreference {
  // The server snapshot is the default: prerendering cannot read `localStorage`, and the client's
  // first paint corrects it long before a card is drawn.
  const seconds = useSyncExternalStore(subscribe, readCardSeconds, () => DEFAULT_CARD_SECONDS);
  const setSeconds = useCallback((next: number) => {
    writeCardSeconds(next);
  }, []);
  return { seconds, setSeconds };
}
