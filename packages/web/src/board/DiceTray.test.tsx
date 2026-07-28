import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AnnouncementBus,
  AnnouncerContext,
  AnnouncerProvider,
  type AnnouncementDraft,
} from "@/a11y";
import type { DiceView } from "@/api";

import { DiceTray, SkipAnimationsToggle, TUMBLE_MS } from "./DiceTray";
import { MOTION_STORAGE_KEY } from "./motion";

function makeDice(overrides: Partial<DiceView> = {}): DiceView {
  return { first: 3, second: 4, purpose: "move", total: 7, is_doubles: false, ...overrides };
}

/**
 * Answer `(prefers-reduced-motion: reduce)` however the test needs.
 *
 * An own property rather than `vi.spyOn`, for the reason spelled out in `motion.test.ts`: restoring
 * a spy on an inherited `Window.prototype` member leaves an own `undefined` behind and makes one
 * test's stub break the next one.
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

/** Reset the module-level motion store to what is on disk. */
function resetMotionStore(): void {
  window.dispatchEvent(new StorageEvent("storage", { key: MOTION_STORAGE_KEY }));
}

function renderTray(dice: DiceView | null, spoken?: AnnouncementDraft[]) {
  const announce = (drafts: AnnouncementDraft | readonly AnnouncementDraft[]): void => {
    // `"key" in drafts` rather than `Array.isArray`, which widens a readonly array to `any[]` and
    // costs a cast that the lint then removes and the typecheck then wants back.
    const list: readonly AnnouncementDraft[] = "key" in drafts ? [drafts] : drafts;
    spoken?.push(...list);
  };
  if (spoken === undefined) {
    return render(
      <AnnouncerProvider>
        <DiceTray dice={dice} />
      </AnnouncerProvider>,
    );
  }
  // A fake bus, so "was it announced" is an assertion about the published API rather than about
  // whatever text happens to end up in the real Announcer's DOM.
  return render(
    <AnnouncerContext.Provider value={{ bus: new AnnouncementBus(), announce }}>
      <DiceTray dice={dice} />
    </AnnouncerContext.Provider>,
  );
}

function dieValues(): number[] {
  return screen.getAllByTestId("die").map((die) => Number(die.getAttribute("data-value")));
}

function pipCount(die: HTMLElement): number {
  return die.querySelectorAll(".kesef-pip").length;
}

beforeEach(() => {
  localStorage.clear();
  resetMotionStore();
  setReducedMotion(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "matchMedia");
  localStorage.clear();
});

describe("the dice show the roll that happened", () => {
  it("draws both faces from the projection", () => {
    renderTray(makeDice({ first: 2, second: 5 }));
    expect(dieValues()).toEqual([2, 5]);
  });

  it("draws the pips a real die has, one per face value", () => {
    for (const value of [1, 2, 3, 4, 5, 6]) {
      const { unmount } = renderTray(makeDice({ first: value, second: value }));
      const dice = screen.getAllByTestId("die");
      const first = dice[0];
      expect(first).toBeDefined();
      if (first !== undefined) {
        expect(pipCount(first), `face ${String(value)}`).toBe(value);
      }
      unmount();
    }
  });

  it("renders the total the wire sent instead of adding the faces up", () => {
    // `DiceView` ships `total` so that no client does arithmetic (G-36). A projection that disagrees
    // with 3 + 4 must be rendered as the projection said — that is what proves nothing here adds.
    renderTray(makeDice({ first: 3, second: 4, total: 99 }));
    expect(screen.getByTestId("dice-total")).toHaveTextContent("99");
  });

  it("renders the doubles flag the wire sent instead of comparing the faces", () => {
    // Two different faces, flagged as doubles. Nonsense on the wire, faithfully shown — the only way
    // to be sure the component is not running `first === second` itself.
    renderTray(makeDice({ first: 2, second: 5, is_doubles: true }));
    expect(screen.getByTestId("dice-doubles")).toBeInTheDocument();

    const { unmount } = renderTray(makeDice({ first: 6, second: 6, is_doubles: false }));
    unmount();
  });

  it("shows no doubles badge when the projection did not flag one", () => {
    renderTray(makeDice({ first: 6, second: 6, is_doubles: false }));
    expect(screen.queryByTestId("dice-doubles")).not.toBeInTheDocument();
  });

  it("says which kind of roll it was, because a rent roll is not a move", () => {
    renderTray(makeDice({ purpose: "jail" }));
    expect(screen.getByText(/leave jail/i)).toBeInTheDocument();
  });

  it("says so plainly before the first roll", () => {
    renderTray(null);
    expect(screen.getByText(/no roll yet/i)).toBeInTheDocument();
    expect(screen.queryAllByTestId("die")).toHaveLength(0);
  });

  it("shows a face the wire invented as a number rather than as a plausible die", () => {
    renderTray(makeDice({ first: 9, second: 1, total: 10 }));
    const dice = screen.getAllByTestId("die");
    const first = dice[0];
    if (first !== undefined) {
      expect(pipCount(first)).toBe(0);
      expect(first).toHaveTextContent("9");
    }
  });

  it("pins the pip layout to ltr inside a Hebrew page (spec 5.3 asks for this by name)", () => {
    renderTray(makeDice());
    for (const die of screen.getAllByTestId("die")) {
      expect(die).toHaveAttribute("dir", "ltr");
    }
  });
});

describe("nothing blocks on the flourish (G-F2)", () => {
  it("renders the authoritative result identically with motion on and off", () => {
    setReducedMotion(false);
    const moving = renderTray(makeDice({ first: 6, second: 6, total: 12, is_doubles: true }));
    const withMotion = {
      values: dieValues(),
      total: screen.getByTestId("dice-total").textContent,
      doubles: screen.queryByTestId("dice-doubles") !== null,
    };
    moving.unmount();

    setReducedMotion(true);
    renderTray(makeDice({ first: 6, second: 6, total: 12, is_doubles: true }));
    expect(dieValues()).toEqual(withMotion.values);
    expect(screen.getByTestId("dice-total").textContent).toBe(withMotion.total);
    expect(screen.queryByTestId("dice-doubles") !== null).toBe(withMotion.doubles);
  });

  it("gives the tumble a zero duration when motion is not wanted", () => {
    setReducedMotion(true);
    renderTray(makeDice());
    for (const die of screen.getAllByTestId("die")) {
      // Zero at the source: a CSS `!important` cannot help a duration JS chose (G-F3).
      expect(die.style.getPropertyValue("--kesef-motion-ms")).toBe("0ms");
    }
  });

  it("gives the tumble a real duration when motion is welcome", () => {
    setReducedMotion(false);
    renderTray(makeDice());
    const dice = screen.getAllByTestId("die");
    const first = dice[0];
    if (first !== undefined) {
      expect(first.style.getPropertyValue("--kesef-motion-ms")).toBe(`${String(TUMBLE_MS)}ms`);
    }
  });

  it("hides nothing while it spins: the result is in the DOM on first render", () => {
    // There is no "after the animation" state to wait for, because there is no state at all — the
    // faces are rendered before any preference is read.
    setReducedMotion(false);
    renderTray(makeDice({ first: 1, second: 1, total: 2, is_doubles: true }));
    expect(dieValues()).toEqual([1, 1]);
    expect(screen.getByTestId("dice-doubles")).toBeInTheDocument();
  });
});

describe("skipping is a real, reachable, remembered switch (G-F1)", () => {
  it("is operable by keyboard alone, not only while something is moving", async () => {
    renderTray(makeDice());
    const toggle = screen.getByTestId("skip-animations");
    toggle.focus();
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("skip-animations")).toHaveAttribute("aria-pressed", "true");
  });

  it("carries a 44 px target", () => {
    renderTray(makeDice());
    expect(screen.getByTestId("skip-animations").className).toMatch(/\btarget\b/);
  });

  it("stops the tumble once pressed", async () => {
    renderTray(makeDice());
    await userEvent.click(screen.getByTestId("skip-animations"));
    for (const die of screen.getAllByTestId("die")) {
      expect(die.style.getPropertyValue("--kesef-motion-ms")).toBe("0ms");
    }
  });

  it("is remembered", async () => {
    renderTray(makeDice());
    await userEvent.click(screen.getByTestId("skip-animations"));
    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBe("true");
  });

  it("announces the change through the Announcer, not through a region of its own", async () => {
    const spoken: AnnouncementDraft[] = [];
    renderTray(makeDice(), spoken);
    await userEvent.click(screen.getByTestId("skip-animations"));
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({ politeness: "polite", key: "a11y.animationsOff" });
    await userEvent.click(screen.getByTestId("skip-animations"));
    expect(spoken[1]).toMatchObject({ key: "a11y.animationsOn" });
  });

  it("never announces the roll: that is the event stream's job (G-D1/G-54)", () => {
    const spoken: AnnouncementDraft[] = [];
    renderTray(makeDice({ first: 6, second: 6, total: 12, is_doubles: true }), spoken);
    // `useEventNarration` already narrates `dice_rolled`. A second push for the same roll is the
    // double-speak defect, whether it comes from a second region or from a second announcement.
    expect(spoken).toHaveLength(0);
  });

  it("reports a system-level preference without pretending the switch is pressed", () => {
    setReducedMotion(true);
    renderTray(makeDice());
    const toggle = screen.getByTestId("skip-animations");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).not.toBeDisabled();
    expect(toggle).toHaveTextContent(/reduced motion/i);
  });
});

describe("narration belongs to the Announcer", () => {
  it("renders no aria-live region anywhere in its subtree", () => {
    const { container } = render(
      <AnnouncerContext.Provider value={{ bus: new AnnouncementBus(), announce: () => undefined }}>
        <DiceTray dice={makeDice()} />
      </AnnouncerContext.Provider>,
    );
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(
      container.querySelectorAll("[role='status'], [role='alert'], [role='log']"),
    ).toHaveLength(0);
  });
});

describe("SkipAnimationsToggle on its own", () => {
  it("can be hosted outside the dice tray", async () => {
    render(
      <AnnouncerProvider>
        <SkipAnimationsToggle />
      </AnnouncerProvider>,
    );
    await userEvent.click(screen.getByTestId("skip-animations"));
    expect(screen.getByTestId("skip-animations")).toHaveAttribute("aria-pressed", "true");
  });
});
