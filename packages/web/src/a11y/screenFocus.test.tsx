/**
 * `useScreenFocus`, and the three things it must *not* do (MON-703).
 *
 * The behaviour is one line — focus the screen's heading — and the value is entirely in the guards, so
 * that is where the tests are. A hook that moved focus on every render would pass a naive "does it
 * focus the heading" test and be unusable: it would yank the keyboard out of whatever control a player
 * had reached, on every event that arrived over the socket.
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SCREEN_HEADING_ATTRIBUTE, useScreenFocus } from "./screenFocus";

/**
 * A screen: a marked heading, and a button somebody might be standing on.
 *
 * `withControl` is how the tests reproduce the defect faithfully. Focus is lost because **React
 * unmounts the element holding it** — not because a test blurred something — so the button is
 * removed by a re-render, in the same commit as the screen change, exactly as a real screen swap does
 * it.
 */
function Screen({
  screen,
  withControl = true,
}: {
  readonly screen: string;
  readonly withControl?: boolean;
}): React.JSX.Element {
  useScreenFocus(screen);
  return (
    <>
      <h1 {...{ [SCREEN_HEADING_ATTRIBUTE]: "" }} tabIndex={-1}>
        {screen}
      </h1>
      {withControl && <button type="button">a control</button>}
    </>
  );
}

describe("useScreenFocus", () => {
  it("moves focus to the screen's heading when the screen changes and focus was lost", () => {
    const { rerender, getByRole } = render(<Screen screen="setup" />);
    // The shape of the defect: a control had focus, the screen swapped, and the browser put focus on
    // the body because the element holding it was unmounted with the screen.
    getByRole("button").focus();

    rerender(<Screen screen="g1" withControl={false} />);

    expect(document.activeElement).toBe(getByRole("heading", { level: 1 }));
  });

  it("says nothing on first paint, when nothing has been pressed", () => {
    // `<body>` is where focus legitimately is before a player has touched the keyboard, and putting a
    // focus ring on the page of somebody who has just loaded it is not an improvement.
    const { getByRole } = render(<Screen screen="setup" />);
    expect(document.activeElement).not.toBe(getByRole("heading", { level: 1 }));
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves focus alone when the player still has it somewhere real", () => {
    // The important guard. A screen change is free to happen while a control is focused — a language
    // switch, a re-render from an event — and stealing focus then is a worse bug than the one this
    // hook fixes, because the player was in the middle of something.
    const { rerender, getByRole } = render(<Screen screen="setup" />);
    const control = getByRole("button");
    control.focus();

    rerender(<Screen screen="g1" />);

    expect(document.activeElement).toBe(control);
  });

  it("does nothing when the screen has not changed, however often it re-renders", () => {
    const { rerender, getByRole } = render(<Screen screen="g1" />);
    getByRole("button").focus();

    // The control goes, focus falls to the body, and the screen is *the same one* throughout — which is
    // what an event stream looks like. This hook is not a general focus repair; the action bar owns that
    // for its own chits (`panels/ActionBar.tsx`), and two mechanisms fighting over one lost focus is
    // worse than either.
    rerender(<Screen screen="g1" withControl={false} />);
    rerender(<Screen screen="g1" withControl={false} />);

    expect(document.activeElement).toBe(document.body);
    expect(document.activeElement).not.toBe(getByRole("heading", { level: 1 }));
  });

  it("does not throw when the new screen has no marked heading", () => {
    // A screen without one is a mistake, but taking the app down over it would be a worse one.
    function Bare({ screen }: { readonly screen: string }): React.JSX.Element {
      useScreenFocus(screen);
      return <p>{screen}</p>;
    }
    const { rerender } = render(<Bare screen="setup" />);
    expect(() => {
      rerender(<Bare screen="g1" />);
    }).not.toThrow();
  });
});
