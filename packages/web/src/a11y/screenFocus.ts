/**
 * Where the keyboard goes when the screen changes (MON-703).
 *
 * ## The defect this exists for
 *
 * The app has two screens and swapping them unmounts one of them whole. Whatever the player was
 * focused on — the start button, the "New game" button — goes with it, and the browser's answer to
 * "the focused element is gone" is to put focus on `<body>`. From `<body>`, Tab starts again at the
 * top of the document, so a keyboard player who has just started a game is silently sent back to the
 * language switch; a screen-reader user is told nothing at all, because nothing has focus to announce.
 *
 * `e2e/keyboard.spec.ts` found it by pressing Enter on the start button and asking where focus was.
 * Two components in this package already carry a comment about the same class of bug —
 * `SkipMotionButton` uses `aria-disabled` rather than `disabled` for it, and `ModalDialog` guards its
 * restore on the target still being connected — which is the fix applied twice where somebody happened
 * to think of it. This is the same fix applied at the level the problem actually lives at.
 *
 * ## Why a heading, and why only when focus was lost
 *
 * A heading is the conventional landing place for a screen change: a screen reader announces it with
 * its level, which is exactly the "you are somewhere else now" a swap needs to say. So each screen
 * marks its own `<h1>` with {@link SCREEN_HEADING_ATTRIBUTE} and `tabIndex={-1}` — focusable
 * programmatically, never a tab stop.
 *
 * The **guard is the important half**. This only moves focus when focus has actually been lost: still
 * on the element that had it, or moved on to something inside the new screen, and this hook does
 * nothing. Otherwise a screen change would be free to yank focus away from a control a player had
 * deliberately reached, which is a worse bug than the one being fixed and much harder to notice.
 *
 * It is also deliberately silent on **first paint**. Nothing has been pressed yet, `<body>` is where
 * focus legitimately is, and moving it would put a focus ring on the page of somebody who has not
 * touched the keyboard.
 */

import { useEffect, useRef } from "react";

/** Marks the one heading per screen that a screen change may move focus to. */
export const SCREEN_HEADING_ATTRIBUTE = "data-screen-heading";

/** `true` when nothing in the document holds focus any more. */
function focusWasLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !document.body.contains(active);
}

/**
 * Move focus to the current screen's heading when `screen` changes and focus was lost.
 *
 * `screen` is any value that differs between screens — the shell passes the game id, or `"setup"`.
 * Child effects run before a parent's, so by the time this runs the new screen's heading is mounted.
 */
export function useScreenFocus(screen: string): void {
  const previous = useRef<string | null>(null);

  useEffect(() => {
    const changed = previous.current !== null && previous.current !== screen;
    previous.current = screen;
    if (!changed || !focusWasLost()) {
      return;
    }
    document.querySelector<HTMLElement>(`[${SCREEN_HEADING_ATTRIBUTE}]`)?.focus();
  }, [screen]);
}
