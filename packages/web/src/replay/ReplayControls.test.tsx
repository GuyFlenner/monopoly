/**
 * The transport controls: bounds, keys, and what a screen reader is told.
 *
 * Three failure modes are worth a test each, and all three pass a naive implementation:
 *
 * 1. **Walking off the end of the log.** A "Forward" that goes to `total + 1` shows the last frame
 *    and a position nobody can reach, so the buttons disable at the bounds and the seek clamps.
 * 2. **Mouse-only stepping.** Buttons are keyboard-operable for free; *arrow* keys are not, and a
 *    replay a keyboard user has to press Tab four times per event to walk is not operable in any
 *    useful sense.
 * 3. **Silent stepping.** The position is on screen, which is nothing at all to somebody listening.
 *    The announcement goes through the one `<Announcer>` bus, and this asserts the key *and* the
 *    params — "event 12 of 96" is the sentence; `replay.position` alone would be a label.
 *
 * The RTL case is the one worth reading twice: `ArrowRight` steps *forward* in English and *back* in
 * Hebrew, because that is what every native slider does. A test that only ran in English would be
 * satisfied by a hardcoded key map, which is the defect.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { AnnouncerProvider, useAnnouncer, type Announcement } from "@/a11y";
import { i18n } from "@/i18n";
import { expectAxeClean } from "@/test/axe";

import { ReplayControls } from "./ReplayControls";

let announced: Announcement[] = [];

/** Records what reached the bus — "was announced" before any dwell timer has run. */
function Recorder(): null {
  const { bus } = useAnnouncer();
  useEffect(
    () =>
      bus.subscribe((added) => {
        announced.push(...added);
      }),
    [bus],
  );
  return null;
}

/** The controls with a real position behind them, so a step's effect is observable. */
function Harness({
  total,
  start,
}: {
  readonly total: number;
  readonly start: number;
}): React.JSX.Element {
  const [position, setPosition] = useState(start);
  return (
    <AnnouncerProvider>
      <Recorder />
      <ReplayControls position={position} total={total} onSeek={setPosition} />
    </AnnouncerProvider>
  );
}

function mount(options: { readonly total: number; readonly start: number }): HTMLElement {
  announced = [];
  const { container } = render(<Harness total={options.total} start={options.start} />);
  return container;
}

function positionText(): string {
  return screen.getByTestId("replay-position").textContent ?? "";
}

function button(step: "first" | "back" | "forward" | "last"): HTMLElement {
  return screen.getByTestId(`replay-${step}`);
}

function slider(): HTMLInputElement {
  return screen.getByTestId("replay-slider") as HTMLInputElement;
}

afterEach(async () => {
  // The suite runs in English (see `src/test/setup.ts`); the RTL case changes it and has to hand it
  // back, or every test after it reads Hebrew.
  if (i18n.language !== "en") {
    await act(async () => {
      await i18n.changeLanguage("en");
    });
  }
});

describe("the position readout", () => {
  it("says where in the log we are, out of how many", () => {
    mount({ total: 96, start: 12 });
    expect(positionText()).toBe("Event 12 of 96");
  });

  it("counts from zero, which is before the first event", () => {
    mount({ total: 96, start: 0 });
    expect(positionText()).toBe("Event 0 of 96");
  });

  it("puts the same sentence on the slider, so it is heard and not just seen", () => {
    mount({ total: 96, start: 12 });
    // A range input announces its value; `aria-valuetext` is what makes that value a sentence
    // instead of the number 12.
    expect(slider()).toHaveAttribute("aria-valuetext", "Event 12 of 96");
    expect(slider().value).toBe("12");
  });
});

describe("stepping", () => {
  it("moves one event at a time", async () => {
    mount({ total: 5, start: 2 });
    await userEvent.click(button("forward"));
    expect(positionText()).toBe("Event 3 of 5");
    await userEvent.click(button("back"));
    expect(positionText()).toBe("Event 2 of 5");
  });

  it("jumps to either end", async () => {
    mount({ total: 5, start: 2 });
    await userEvent.click(button("last"));
    expect(positionText()).toBe("Event 5 of 5");
    await userEvent.click(button("first"));
    expect(positionText()).toBe("Event 0 of 5");
  });

  it("follows the slider", async () => {
    mount({ total: 5, start: 0 });
    // A drag arrives as a change on the input, not as typing. `fireEvent.change` is the spelling
    // that goes through React's value tracker; setting `.value` by hand does not.
    fireEvent.change(slider(), { target: { value: "4" } });
    expect(positionText()).toBe("Event 4 of 5");
  });
});

describe("the bounds", () => {
  it("offers nothing to go back to at the start", () => {
    mount({ total: 5, start: 0 });
    expect(button("first")).toBeDisabled();
    expect(button("back")).toBeDisabled();
    expect(button("forward")).toBeEnabled();
    expect(button("last")).toBeEnabled();
  });

  it("offers nothing to go forward to at the end", () => {
    mount({ total: 5, start: 5 });
    expect(button("forward")).toBeDisabled();
    expect(button("last")).toBeDisabled();
    expect(button("back")).toBeEnabled();
  });

  it("clamps a keystroke that would walk off the end", async () => {
    mount({ total: 2, start: 2 });
    button("back").focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(positionText()).toBe("Event 2 of 2");
    // And nothing was announced, because nothing moved.
    expect(announced).toEqual([]);
  });

  it("holds the slider's range to the log", () => {
    mount({ total: 7, start: 3 });
    expect(slider()).toHaveAttribute("min", "0");
    expect(slider()).toHaveAttribute("max", "7");
  });
});

describe("the keyboard", () => {
  it("steps with the arrow keys, from a button", async () => {
    mount({ total: 9, start: 4 });
    button("forward").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(positionText()).toBe("Event 5 of 9");
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(positionText()).toBe("Event 3 of 9");
  });

  it("jumps with Home and End", async () => {
    mount({ total: 9, start: 4 });
    button("back").focus();
    await userEvent.keyboard("{End}");
    expect(positionText()).toBe("Event 9 of 9");
    await userEvent.keyboard("{Home}");
    expect(positionText()).toBe("Event 0 of 9");
  });

  it("reverses the arrows in Hebrew, as a native slider does", async () => {
    await act(async () => {
      await i18n.changeLanguage("he");
    });
    mount({ total: 9, start: 4 });
    button("forward").focus();

    // Right is *back* in a right-to-left document: the log runs the other way across the screen.
    await userEvent.keyboard("{ArrowRight}");
    expect(positionText()).toContain("3");
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(positionText()).toContain("5");
  });

  it("leaves keys it does not handle alone", async () => {
    mount({ total: 9, start: 4 });
    button("first").focus();
    // Tab still has to move focus: a handler that called `preventDefault` unconditionally would
    // trap a keyboard user inside four buttons.
    await userEvent.keyboard("{Tab}");
    expect(button("first")).not.toHaveFocus();
  });
});

describe("what is announced", () => {
  it("says the new position through the shared bus", async () => {
    mount({ total: 96, start: 11 });
    await userEvent.click(button("forward"));

    expect(announced).toHaveLength(1);
    expect(announced[0]?.key).toBe("replay.position");
    expect(announced[0]?.params).toEqual({ position: 12, total: 96 });
    // Politely: a replay is read at the reader's pace, and interrupting them is for the moments the
    // acting player changes (GAP D1/D2).
    expect(announced[0]?.politeness).toBe("polite");
  });

  it("announces a keyboard step too", async () => {
    mount({ total: 96, start: 11 });
    button("back").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(announced.map((entry) => entry.params)).toEqual([{ position: 12, total: 96 }]);
  });

  it("stays quiet when the slider moves itself", () => {
    // The range input speaks its own `aria-valuetext`. A second sentence from the bus would be the
    // same position said twice — the double-speak the whole a11y layer is built to avoid.
    mount({ total: 96, start: 11 });
    fireEvent.change(slider(), { target: { value: "40" } });
    expect(positionText()).toBe("Event 40 of 96");
    expect(announced).toEqual([]);
  });
});

describe("accessibility", () => {
  it("is a named group, and axe clean", async () => {
    const container = mount({ total: 9, start: 4 });
    expect(screen.getByRole("group", { name: "Replay controls" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Position in the game" })).toBeInTheDocument();
    await expectAxeClean(container);
  });
});
