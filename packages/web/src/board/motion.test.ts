import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MOTION_STORAGE_KEY, useMotionPreference } from "./motion";

/**
 * Answer `(prefers-reduced-motion: reduce)` however the test needs.
 *
 * jsdom's `matchMedia` always reports `matches: false`, so the preference is unreachable without a
 * stub — and "reads the preference in JS" is precisely the acceptance criterion (G-F3), so it has to
 * be reachable.
 *
 * An own property rather than `vi.spyOn`. `matchMedia` lives on `Window.prototype` in jsdom, and
 * restoring a spy on an inherited property leaves an own `undefined` behind, so one test that stubs
 * it silently breaks the next — an order dependency that is far more annoying to find than it is to
 * avoid. Defining and deleting our own property is exact in both directions.
 */
function setReducedMotion(reduce: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: query.includes("prefers-reduced-motion") && reduce,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

/** Take `matchMedia` away entirely, as an embedded webview might. */
function withoutMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

/** Hand jsdom's own implementation back. */
function restoreMatchMedia(): void {
  Reflect.deleteProperty(window, "matchMedia");
}

/** A fresh mount, as though the page had just loaded. */
function mount() {
  return renderHook(() => useMotionPreference()).result;
}

/** Drop the in-memory value, forcing the next read to come from storage — a real cross-tab path. */
function asAnotherTab(): void {
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: MOTION_STORAGE_KEY }));
  });
}

beforeEach(() => {
  localStorage.clear();
  // Each test starts from disk, not from whatever a previous test left in the module's cache.
  asAnotherTab();
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreMatchMedia();
  localStorage.clear();
});

describe("the operating system's preference", () => {
  it("is read rather than assumed", () => {
    setReducedMotion(true);
    expect(mount().current.reduced).toBe(true);
  });

  it("permits motion when nothing has asked otherwise", () => {
    setReducedMotion(false);
    const hook = mount();
    expect(hook.current.reduced).toBe(false);
    expect(hook.current.skip).toBe(false);
  });

  it("survives an environment with no matchMedia at all", () => {
    // Some embedded webviews have none. A missing preference must not be a crash on a screen whose
    // whole job is to be usable.
    withoutMatchMedia();
    expect(mount().current.reduced).toBe(false);
  });
});

describe("durations", () => {
  it("is zero at the source when motion is not wanted, not merely shorter", () => {
    // The whole point of G-F3: an animation whose duration JS chooses cannot be helped by a CSS
    // `!important`, so the number itself has to be zero.
    setReducedMotion(true);
    expect(mount().current.durationMs(420)).toBe(0);
  });

  it("passes the asked-for duration through when motion is welcome", () => {
    setReducedMotion(false);
    expect(mount().current.durationMs(420)).toBe(420);
  });
});

describe("the player's own switch", () => {
  it("skips animations even when the system has not asked", () => {
    setReducedMotion(false);
    const hook = mount();
    act(() => {
      hook.current.setChosen(true);
    });
    expect(hook.current.chosen).toBe(true);
    expect(hook.current.skip).toBe(true);
    expect(hook.current.durationMs(420)).toBe(0);
  });

  it("stays distinct from the system preference", () => {
    // A player who asked the OS for stillness should not see the in-game switch reading "pressed",
    // and flipping the in-game switch has not changed their OS setting.
    setReducedMotion(true);
    const hook = mount();
    expect(hook.current.reduced).toBe(true);
    expect(hook.current.chosen).toBe(false);
    expect(hook.current.skip).toBe(true);
  });

  it("is remembered, so a flourish never has to be skipped twice", () => {
    setReducedMotion(false);
    const hook = mount();
    act(() => {
      hook.current.setChosen(true);
    });
    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBe("true");
    // Force the value to be re-read from storage rather than from the module's cache, so this
    // asserts persistence and not merely that a variable held its value.
    asAnotherTab();
    expect(mount().current.chosen).toBe(true);
  });

  it("toggles both ways", () => {
    setReducedMotion(false);
    const hook = mount();
    act(() => {
      hook.current.toggle();
    });
    expect(hook.current.chosen).toBe(true);
    act(() => {
      hook.current.toggle();
    });
    expect(hook.current.chosen).toBe(false);
    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBe("false");
  });

  it("keeps two mounted copies of the switch in agreement", () => {
    // One toggle under the board and one in a settings panel must not disagree, or a player turns
    // animation off in one place and watches it play in the other.
    setReducedMotion(false);
    const board = mount();
    const settings = mount();
    act(() => {
      board.current.setChosen(true);
    });
    expect(settings.current.chosen).toBe(true);
  });

  it("still takes effect when localStorage refuses the write", () => {
    // Private browsing throws on `setItem`. The choice cannot survive a reload there, but it must
    // work now — these are exactly the devices where an accessibility switch matters most.
    setReducedMotion(false);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("private mode");
    });
    const hook = mount();
    act(() => {
      hook.current.setChosen(true);
    });
    expect(hook.current.chosen).toBe(true);
    expect(hook.current.skip).toBe(true);
    expect(hook.current.durationMs(420)).toBe(0);
  });

  it("tolerates a stored value that is not a boolean", () => {
    setReducedMotion(false);
    localStorage.setItem(MOTION_STORAGE_KEY, "yes please");
    asAnotherTab();
    expect(mount().current.chosen).toBe(false);
  });
});
