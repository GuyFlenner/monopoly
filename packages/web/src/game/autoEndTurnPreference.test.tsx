/**
 * The auto-end-turn preference, and the fact that it survives a reload.
 *
 * Same shape as `sound/mute.test.ts`, because it is the same kind of thing: a persisted switch whose
 * only real risk is forgetting. The one difference worth testing on its own is the **default**, which
 * is `true` here rather than `false` — the owner asked for the behaviour, so a player who has never
 * opened the chrome gets it — and which flips the spelling of the read from `=== "true"` to
 * `!== "false"`. Both of the "not a value we wrote" cases below exist to pin that spelling.
 */

import { act, render, renderHook, screen } from "@testing-library/react";
import { useEffect } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Announcer, AnnouncerProvider, useAnnouncer } from "@/a11y";

import { AutoEndTurnToggle } from "./AutoEndTurnToggle";
import {
  AUTO_END_TURN_STORAGE_KEY,
  DEFAULT_AUTO_END_TURN,
  forgetCachedAutoEndTurn,
  readAutoEndTurn,
  useAutoEndTurnPreference,
  writeAutoEndTurn,
} from "./autoEndTurnPreference";

/** What reached the bus, which is "was announced" before any dwell timer has run. */
let announced: Array<{ politeness: string; key: string }> = [];

function Recorder(): null {
  const { bus } = useAnnouncer();
  useEffect(
    () =>
      bus.subscribe((added) => {
        announced.push(
          ...added.map((announcement) => ({
            politeness: announcement.politeness,
            key: announcement.key,
          })),
        );
      }),
    [bus],
  );
  return null;
}

beforeEach(() => {
  announced = [];
  globalThis.localStorage.clear();
  // The store caches, deliberately, so a test that writes storage behind its back has to say so.
  forgetCachedAutoEndTurn();
  vi.restoreAllMocks();
});

describe("the preference", () => {
  it("defaults to on, because the owner asked for the behaviour", () => {
    expect(DEFAULT_AUTO_END_TURN).toBe(true);
    expect(readAutoEndTurn()).toBe(true);
  });

  it("round-trips a choice through storage", () => {
    writeAutoEndTurn(false);
    expect(globalThis.localStorage.getItem(AUTO_END_TURN_STORAGE_KEY)).toBe("false");

    // The reload. Without the persistence this is the assertion that fails, which is what makes it
    // the test the feature is actually about.
    forgetCachedAutoEndTurn();
    expect(readAutoEndTurn()).toBe(false);

    writeAutoEndTurn(true);
    forgetCachedAutoEndTurn();
    expect(readAutoEndTurn()).toBe(true);
  });

  it("reads a choice a previous session left behind", () => {
    globalThis.localStorage.setItem(AUTO_END_TURN_STORAGE_KEY, "false");
    forgetCachedAutoEndTurn();
    expect(readAutoEndTurn()).toBe(false);
  });

  it("treats a value it did not write as the default", () => {
    // `!== "false"` rather than `=== "true"`, which is the mirror image of `mute.ts`'s spelling. A key
    // holding rubbish — another version's value, a corrupted profile — must mean *on*, because that is
    // the default, and only this spelling gives that.
    globalThis.localStorage.setItem(AUTO_END_TURN_STORAGE_KEY, "yes please");
    forgetCachedAutoEndTurn();
    expect(readAutoEndTurn()).toBe(true);
  });

  it("keeps working when storage refuses to be written", () => {
    vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("private mode");
    });
    writeAutoEndTurn(false);
    // The choice cannot be remembered past this page, and it still took effect. A switch that appears
    // not to work is worse than one that forgets.
    expect(readAutoEndTurn()).toBe(false);
  });

  it("is one value for the whole document, not one per component", () => {
    const first = renderHook(() => useAutoEndTurnPreference());
    const second = renderHook(() => useAutoEndTurnPreference());

    act(() => {
      first.result.current.toggle();
    });
    // Two switches in different subtrees must not be able to disagree about what the game is doing.
    expect(first.result.current.autoEndTurn).toBe(false);
    expect(second.result.current.autoEndTurn).toBe(false);
  });
});

describe("the switch in the chrome", () => {
  function renderToggle() {
    return render(
      // The same shape as `MuteToggle.test.tsx`: the provider owns the bus, `<Announcer>` is a
      // sibling live region rather than a wrapper, and the switch pushes through the one of them.
      <AnnouncerProvider>
        <Announcer stepMs={5} />
        <Recorder />
        <AutoEndTurnToggle />
      </AnnouncerProvider>,
    );
  }

  it("reports the feature's state as its pressed state", () => {
    renderToggle();
    // Pressed means "turns end by themselves", matching the label. The other direction reads correctly
    // in English and inverts the moment Hebrew renders the label as a noun — `MuteToggle`'s argument.
    expect(screen.getByTestId("auto-end-turn")).toHaveAttribute("aria-pressed", "true");
  });

  it("flips the stored choice and says where the press took us", async () => {
    renderToggle();
    await userEvent.click(screen.getByRole("button", { name: "Auto end turn" }));

    expect(screen.getByTestId("auto-end-turn")).toHaveAttribute("aria-pressed", "false");
    expect(readAutoEndTurn()).toBe(false);
    // Asserted at the bus rather than in the region's text, which is `MuteToggle.test.tsx`'s idiom
    // and for its reason: the region is serialized behind a dwell timer, so reading its text is a
    // test of the Announcer's clock — which `Announcer.test.tsx` already owns — rather than of this
    // switch. What belongs here is that the press said the state it moved *to*, politely, once.
    expect(announced).toEqual([{ politeness: "polite", key: "a11y.auto_end_off" }]);

    await userEvent.click(screen.getByRole("button", { name: "Auto end turn" }));
    expect(announced.at(-1)).toEqual({ politeness: "polite", key: "a11y.auto_end_on" });
  });

  it("keeps the 44 px floor and needs no mouse", async () => {
    renderToggle();
    const button = screen.getByTestId("auto-end-turn");
    expect(button.className).toContain("target");

    await userEvent.tab();
    expect(button).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(button).toHaveAttribute("aria-pressed", "false");
  });
});
