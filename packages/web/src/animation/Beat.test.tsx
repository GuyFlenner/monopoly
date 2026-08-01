/**
 * The three presentational leaves: the flourish wrappers, the skip button, and the gesture surface.
 *
 * ## The falsifier
 *
 * Every one of these could be implemented in a way that *gates* something, and gating is the one
 * thing MON-701 forbids. So the tests here assert the negative directly:
 *
 * - `<Pulse>` and `<Pop>` render their children at their final value with **no beat, a zero beat and
 *   a live beat alike**. An implementation that faded a figure in, or waited for `animationend`
 *   before showing it, fails the first assertion — and that implementation is the natural one to
 *   write.
 * - The skip button stays in the DOM and stays focusable when there is nothing to skip, because a
 *   control that vanishes on press takes the keyboard focus with it.
 * - `<FastForward>` does not swallow the gesture: a click inside it reaches the child's own handler
 *   *as well as* the skip. Calling `stopPropagation` would be the obvious way to write it and would
 *   break opening a square.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MOTION_STORAGE_KEY } from "@/board";

import { Pop, Pulse } from "./Beat";
import { FastForward } from "./FastForward";
import { SkipMotionButton } from "./SkipMotionButton";

/**
 * Reset the persisted motion switch.
 *
 * `motion.ts` keeps the live value in memory and `localStorage` only as the persistence, so writing
 * the key is not enough — the `storage` event is the documented way to drop the cached boolean, and
 * it is what `DiceTray.test.tsx` and `motion.test.ts` both use.
 */
function setSkipAnimations(skip: boolean): void {
  globalThis.localStorage.setItem(MOTION_STORAGE_KEY, skip ? "true" : "false");
  window.dispatchEvent(new StorageEvent("storage", { key: MOTION_STORAGE_KEY }));
}

beforeEach(() => {
  setSkipAnimations(false);
});

describe("a flourish never hides what it decorates", () => {
  it("renders the figure with no beat at all, and adds no wrapper element", () => {
    const { container } = render(
      <Pulse>
        <span data-testid="figure">1500</span>
      </Pulse>,
    );
    expect(screen.getByTestId("figure")).toHaveTextContent("1500");
    // No beat means no animation layer is wired to this mark, so the DOM is exactly what it was
    // before MON-701 existed — which is what keeps every pre-existing component test honest.
    expect(container.querySelector('[data-testid="cash-pulse"]')).toBeNull();
  });

  it("renders the figure at a zero beat, still", () => {
    render(
      <Pulse nonce={0}>
        <span data-testid="figure">1500</span>
      </Pulse>,
    );
    expect(screen.getByTestId("figure")).toHaveTextContent("1500");
    // Wrapped — the layer is present — but not animating: a card must not pulse merely for mounting.
    expect(screen.getByTestId("cash-pulse").className).not.toContain("kesef-pulse");
  });

  it("animates on a bumped beat, with the figure unchanged", () => {
    const { rerender } = render(
      <Pulse nonce={0}>
        <span data-testid="figure">1500</span>
      </Pulse>,
    );
    rerender(
      <Pulse nonce={1}>
        <span data-testid="figure">1300</span>
      </Pulse>,
    );

    const wrapper = screen.getByTestId("cash-pulse");
    expect(wrapper.className).toContain("kesef-pulse");
    expect(wrapper).toHaveAttribute("data-beat", "1");
    expect(screen.getByTestId("figure")).toHaveTextContent("1300");
  });

  it("pops a building the same way", () => {
    render(
      <Pop nonce={3}>
        <span data-testid="houses">3</span>
      </Pop>,
    );
    expect(screen.getByTestId("building-pop").className).toContain("kesef-pop");
    expect(screen.getByTestId("houses")).toHaveTextContent("3");
  });

  it("collapses the duration to zero when the player has switched animations off", () => {
    // Zero rather than a second code path: a `0ms` animation still starts and still ends, so the
    // still board runs the same code as the moving one (`board/motion.ts`, GAP G-F3).
    setSkipAnimations(true);
    render(
      <Pulse nonce={2}>
        <span>1500</span>
      </Pulse>,
    );
    expect(screen.getByTestId("cash-pulse").style.getPropertyValue("--kesef-motion-ms")).toBe(
      "0ms",
    );
  });
});

describe("the skip button", () => {
  it("catches the timeline up when something is moving", async () => {
    const onSkip = vi.fn();
    render(<SkipMotionButton playing onSkip={onSkip} />);

    await userEvent.click(screen.getByTestId("skip-motion"));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("stays in the DOM, focusable and inert, when there is nothing to skip", async () => {
    const onSkip = vi.fn();
    render(<SkipMotionButton playing={false} onSkip={onSkip} />);

    const button = screen.getByTestId("skip-motion");
    // `aria-disabled`, not `disabled`, and never absent: a control that unmounts on press drops the
    // keyboard focus to the body in the middle of a turn.
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    button.focus();
    expect(button).toHaveFocus();

    await userEvent.click(button);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("says which state it is in for a reader who cannot see that it is dimmed", () => {
    render(<SkipMotionButton playing={false} onSkip={vi.fn()} />);
    expect(screen.getByTestId("skip-motion")).toHaveTextContent("Nothing is moving");
  });

  it("carries the hit-target floor", () => {
    render(<SkipMotionButton playing onSkip={vi.fn()} />);
    expect(screen.getByTestId("skip-motion").className).toContain("target");
  });
});

describe("the fast-forward surface", () => {
  it("catches up on a click without swallowing it", async () => {
    const onSkip = vi.fn();
    const onInner = vi.fn();
    render(
      <FastForward onSkip={onSkip}>
        <button type="button" onClick={onInner}>
          open
        </button>
      </FastForward>,
    );

    await userEvent.click(screen.getByRole("button", { name: "open" }));
    // Both. `stopPropagation` is the obvious way to write this and would break opening a square.
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onInner).toHaveBeenCalledTimes(1);
  });

  it("catches up on a keypress", async () => {
    const onSkip = vi.fn();
    render(
      <FastForward onSkip={onSkip}>
        <button type="button">open</button>
      </FastForward>,
    );

    screen.getByRole("button", { name: "open" }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(onSkip).toHaveBeenCalled();
  });

  it("adds no role and no tab stop of its own", () => {
    render(
      <FastForward onSkip={vi.fn()}>
        <span>board</span>
      </FastForward>,
    );
    const surface = screen.getByTestId("fast-forward");
    // It is not a control: there is nothing here to activate, and the real affordance is the button
    // beside it. Giving it a role would put a second, meaningless stop in the tab order.
    expect(surface.getAttribute("role")).toBeNull();
    expect(surface.getAttribute("tabindex")).toBeNull();
  });
});
