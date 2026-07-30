/**
 * The mute, and the fact that it survives a reload (MON-706).
 *
 * The acceptance criterion is "a mute that persists", and "persists" is the whole of it: a toggle
 * that works and forgets is a toggle a parent presses at the start of every game. So the tests here
 * are about the *storage*, in both directions and in the two conditions that break it — a fresh
 * profile, and a browser that refuses to be written to.
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MUTED,
  forgetCachedMute,
  MUTE_STORAGE_KEY,
  readMuted,
  useMutePreference,
  writeMuted,
} from "./mute";

beforeEach(() => {
  globalThis.localStorage.clear();
  // The store caches, deliberately (see the module docstring), so a test that writes storage behind
  // its back has to say so — otherwise it reads a value an earlier test left in memory.
  forgetCachedMute();
  vi.restoreAllMocks();
});

describe("the mute preference", () => {
  it("defaults to unmuted on a profile that has never chosen", () => {
    // Not the cautious default, and on purpose: a game that ships silent is a game whose sound
    // nobody discovers. The switch is one press away in the chrome.
    expect(DEFAULT_MUTED).toBe(false);
    expect(readMuted()).toBe(false);
  });

  it("round-trips a choice through storage", () => {
    writeMuted(true);
    expect(globalThis.localStorage.getItem(MUTE_STORAGE_KEY)).toBe("true");

    // The reload: drop everything held in memory and ask again. Without the persistence this is the
    // assertion that fails, which is what makes it the test the feature is actually about.
    forgetCachedMute();
    expect(readMuted()).toBe(true);

    writeMuted(false);
    forgetCachedMute();
    expect(readMuted()).toBe(false);
  });

  it("reads a choice a previous session left behind", () => {
    globalThis.localStorage.setItem(MUTE_STORAGE_KEY, "true");
    forgetCachedMute();
    expect(readMuted()).toBe(true);
  });

  it("treats a value it did not write as the default", () => {
    // `=== "true"` rather than `!== "false"`. A key holding rubbish — a different version's value, a
    // corrupted profile — must mean "unmuted", not "muted because it is not the string false".
    globalThis.localStorage.setItem(MUTE_STORAGE_KEY, "yes please");
    forgetCachedMute();
    expect(readMuted()).toBe(false);
  });

  it("still takes effect when storage cannot be written", () => {
    // A private browsing mode throws on `setItem`. The choice has to work *now* even though it
    // cannot be remembered — this is the case that made the live value live in memory rather than
    // being read back out of storage, and getting it wrong means the switch appears not to work at
    // all on exactly the devices where accessibility settings matter most.
    vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });

    expect(() => {
      writeMuted(true);
    }).not.toThrow();
    expect(readMuted()).toBe(true);
  });

  it("falls back to the default when storage cannot be read", () => {
    vi.spyOn(globalThis.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });
    forgetCachedMute();
    expect(readMuted()).toBe(DEFAULT_MUTED);
  });

  it("pushes a write out to every mounted switch", () => {
    // The reason the store is module-level rather than React state. Two toggles — one in the chrome,
    // one in a settings sheet a sibling adds — must not be able to disagree, and that only holds if
    // a write *notifies*: without `notify()` the hook below keeps rendering the old boolean until
    // something unrelated re-renders it, and the second switch silently lies about the state.
    const { result: first } = renderHook(() => useMutePreference());
    const { result: second } = renderHook(() => useMutePreference());
    expect([first.current.muted, second.current.muted]).toEqual([false, false]);

    // Written from outside either hook, which is what a *second* control amounts to.
    act(() => {
      writeMuted(true);
    });
    expect([first.current.muted, second.current.muted]).toEqual([true, true]);

    act(() => {
      first.current.toggle();
    });
    expect([first.current.muted, second.current.muted]).toEqual([false, false]);
  });
});
