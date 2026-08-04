/**
 * The card-dwell preference (MON-719).
 *
 * Three things are worth a test here, and they are the three that were got wrong in the two
 * preferences this one copies: that a choice takes effect *now* even when it cannot be stored, that a
 * value from disk which this build would not accept reads as the default rather than as itself, and
 * that a second tab is the same player changing their mind.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CARD_DWELL_STORAGE_KEY,
  cardDwellMs,
  clampCardSeconds,
  DEFAULT_CARD_SECONDS,
  forgetCachedCardSeconds,
  MAX_CARD_SECONDS,
  MIN_CARD_SECONDS,
  readCardSeconds,
  writeCardSeconds,
} from "./cardDwell";
import { DEFAULT_DURATIONS } from "./timeline";

beforeEach(() => {
  globalThis.localStorage.removeItem(CARD_DWELL_STORAGE_KEY);
  forgetCachedCardSeconds();
});

describe("the default", () => {
  it("is what the timeline plays when nobody has chosen", () => {
    // The two must agree, or a first-time player gets a dwell no setting shows. Asserted rather than
    // assumed, because they are declared in two files.
    expect(readCardSeconds()).toBe(DEFAULT_CARD_SECONDS);
    expect(cardDwellMs(DEFAULT_CARD_SECONDS)).toBe(DEFAULT_DURATIONS.cardMs);
  });

  it("is long enough to outlast the announcement of a card", () => {
    // The property the old 1800 ms was chosen for and this default keeps: the card is still on screen
    // when the polite region has finished saying it, so a sighted reader and a screen-reader user are
    // on one clock. `<Announcer>`'s step is 1200 ms; two steps is a generous reading of one card.
    expect(cardDwellMs(DEFAULT_CARD_SECONDS)).toBeGreaterThan(2 * 1200);
  });
});

describe("what a stored value is allowed to be", () => {
  it("keeps a choice inside the offered range", () => {
    writeCardSeconds(8);
    expect(readCardSeconds()).toBe(8);
    expect(globalThis.localStorage.getItem(CARD_DWELL_STORAGE_KEY)).toBe("8");
  });

  it("reads a value this build would not offer as the default", () => {
    // A hand-edited storage, or a ceiling a later build lowered. The alternative is a card that stays
    // up for an hour because a number on disk said so.
    for (const stored of ["0", "-3", "999", "", "soon", "[]"]) {
      globalThis.localStorage.setItem(CARD_DWELL_STORAGE_KEY, stored);
      forgetCachedCardSeconds();
      expect(readCardSeconds(), stored).toBe(DEFAULT_CARD_SECONDS);
    }
  });

  it("refuses to store a value it would not read back", () => {
    // The failure this prevents is a field that appears to accept 60 and a game that plays 5: the
    // write is clamped by the same function the read is, so the two cannot disagree.
    writeCardSeconds(60);
    expect(readCardSeconds()).toBe(DEFAULT_CARD_SECONDS);
    expect(globalThis.localStorage.getItem(CARD_DWELL_STORAGE_KEY)).toBe(
      String(DEFAULT_CARD_SECONDS),
    );
  });

  it("rounds a fraction rather than rejecting it", () => {
    // A number input with `step={1}` can still be handed `4.6` by a keyboard. Four and a half seconds
    // is a real answer to "how long"; it is simply not one this setting distinguishes.
    expect(clampCardSeconds("4.6")).toBe(5);
    expect(clampCardSeconds(MIN_CARD_SECONDS - 0.4)).toBe(MIN_CARD_SECONDS);
    expect(clampCardSeconds(MAX_CARD_SECONDS + 0.4)).toBe(MAX_CARD_SECONDS);
    // And a value that is not a number at all is not a choice.
    expect(clampCardSeconds(null)).toBeNull();
    expect(clampCardSeconds(Number.NaN)).toBeNull();
    expect(clampCardSeconds(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("when the choice cannot be written down", () => {
  it("still takes effect for this page", () => {
    // Private browsing throws on `setItem`. A preference that failed *silently and completely* would
    // be a control that appears not to work at all, which is the defect `sound/mute.ts` documents.
    const setItem = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    expect(() => {
      writeCardSeconds(9);
    }).not.toThrow();
    expect(readCardSeconds(), "the choice did not take effect in memory").toBe(9);

    setItem.mockRestore();
  });

  it("falls back to the default when storage cannot even be read", () => {
    const getItem = vi.spyOn(globalThis.localStorage, "getItem").mockImplementation(() => {
      throw new Error("access denied");
    });
    forgetCachedCardSeconds();

    expect(readCardSeconds()).toBe(DEFAULT_CARD_SECONDS);

    getItem.mockRestore();
  });
});

describe("a second tab", () => {
  it("is the same player changing their mind", () => {
    writeCardSeconds(7);
    expect(readCardSeconds()).toBe(7);

    // What the browser does when another tab of the same origin writes: the value on disk has already
    // changed, and this tab has to stop trusting the number it cached.
    globalThis.localStorage.setItem(CARD_DWELL_STORAGE_KEY, "3");
    globalThis.dispatchEvent(new StorageEvent("storage", { key: CARD_DWELL_STORAGE_KEY }));

    expect(readCardSeconds()).toBe(3);
  });

  it("notices storage being cleared wholesale", () => {
    writeCardSeconds(7);
    globalThis.localStorage.clear();
    globalThis.dispatchEvent(new StorageEvent("storage", { key: null }));

    expect(readCardSeconds()).toBe(DEFAULT_CARD_SECONDS);
  });
});
