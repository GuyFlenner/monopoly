/**
 * The mute switch (MON-706).
 *
 * Four requirements, and each has a test: default unmuted, keyboard reachable, labelled from the
 * catalogue, and >= 44 px. The fifth — that the choice persists — belongs to `mute.test.ts`, which
 * owns the storage; this file is about the control.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { Announcer, AnnouncerProvider, useAnnouncer } from "@/a11y";
import { expectAxeClean } from "@/test/axe";
import { useEffect } from "react";

import { forgetCachedMute, MUTE_STORAGE_KEY } from "./mute";
import { MuteToggle } from "./MuteToggle";

let announced: string[] = [];

/** What reached the bus, which is "was announced" before any dwell timer has run. */
function Recorder(): null {
  const { bus } = useAnnouncer();
  useEffect(
    () =>
      bus.subscribe((added) => {
        announced.push(...added.map((announcement) => announcement.key));
      }),
    [bus],
  );
  return null;
}

function renderToggle(): void {
  render(
    <AnnouncerProvider>
      <Announcer stepMs={5} />
      <Recorder />
      <MuteToggle />
    </AnnouncerProvider>,
  );
}

beforeEach(() => {
  announced = [];
  globalThis.localStorage.clear();
  forgetCachedMute();
});

describe("MuteToggle", () => {
  it("starts unmuted, labelled from the catalogue", () => {
    renderToggle();
    const button = screen.getByRole("button", { name: "Mute sound" });
    // `aria-pressed` reflects *muted*, matching the label. A "Sound" toggle whose pressed state
    // meant unmuted would read correctly in English and invert the moment the label is a noun,
    // which is what Hebrew does.
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("mutes on a press and remembers it", async () => {
    renderToggle();
    await userEvent.click(screen.getByRole("button", { name: "Mute sound" }));

    expect(screen.getByRole("button", { name: /Mute sound/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(globalThis.localStorage.getItem(MUTE_STORAGE_KEY)).toBe("true");
  });

  it("is reachable and operable from the keyboard", async () => {
    // A real `<button>`, so Tab reaches it and Space presses it. Asserted rather than assumed
    // because the equivalent control built as a styled `<div>` passes a click test and fails this.
    renderToggle();
    await userEvent.tab();

    const button = screen.getByRole("button", { name: /Mute sound/ });
    expect(button).toHaveFocus();

    await userEvent.keyboard(" ");
    expect(button).toHaveAttribute("aria-pressed", "true");

    await userEvent.keyboard("{Enter}");
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("announces the state it moved to, through the one shared region", async () => {
    // The one thing only this component knows. The events themselves are narrated from the stream;
    // saying anything about them here would be the GAP D1/G-54 double-speak defect — which is why
    // the assertion is also that no *second* region appeared.
    renderToggle();
    const button = screen.getByRole("button", { name: /Mute sound/ });

    await userEvent.click(button);
    expect(announced).toEqual(["a11y.sound_off"]);

    await userEvent.click(button);
    expect(announced).toEqual(["a11y.sound_off", "a11y.sound_on"]);

    expect(document.querySelectorAll("[aria-live]")).toHaveLength(2);
  });

  it("carries the 44 px target class the rest of the chrome uses", () => {
    // The floor is enforced by the `target` utility (`MIN_TARGET_PX`, asserted in
    // `theme/surfaces.test.ts`), and jsdom lays nothing out — so what is checkable here is that this
    // control opted into it rather than styling its own smaller box.
    renderToggle();
    expect(screen.getByTestId("mute-sound").className).toContain("target");
  });

  it("is axe clean in both states", async () => {
    const { container } = render(
      <AnnouncerProvider>
        <MuteToggle />
      </AnnouncerProvider>,
    );
    await expectAxeClean(container);

    await userEvent.click(screen.getByRole("button", { name: /Mute sound/ }));
    await expectAxeClean(container);
  });
});
