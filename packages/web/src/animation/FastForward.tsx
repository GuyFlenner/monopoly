/**
 * "Any click or keypress on the board fast-forwards the animation to now" — MON-701, made literal.
 *
 * A transparent wrapper whose only job is to notice that the player did something. It adds no role,
 * no tab stop, no visual, and it never calls `preventDefault` or `stopPropagation`: the board's own
 * click and key handling runs exactly as before, and the gesture that opened a square also finishes
 * the flourish. Impatience is an instruction, and the natural way to express it is to reach for the
 * thing you were going to touch anyway.
 *
 * ## Why native listeners rather than `onClick`
 *
 * A `<div onClick>` is a static element with a mouse handler, which `jsx-a11y` rightly asks to be
 * given a role and a keyboard equivalent — advice aimed at divs that are secretly buttons. This one
 * is not a control: there is nothing here to activate, nothing to focus, and the *only* affordance
 * is the real `<button>` beside it (`SkipMotionButton`). Registering in the capture phase through a
 * ref says that plainly, keeps the accessibility tree untouched, and needs no suppressed lint rule
 * to do it.
 *
 * The capture phase, specifically, so that a click on a square fast-forwards *before* the square's
 * own handler opens its detail sheet — the piece is on its true square by the time the sheet
 * describing it appears.
 */

import { useEffect, useRef, type ReactNode } from "react";

export interface FastForwardProps {
  readonly onSkip: () => void;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}

export function FastForward({ onSkip, children, className }: FastForwardProps): React.JSX.Element {
  const node = useRef<HTMLDivElement | null>(null);
  // Held in a ref so a fresh `onSkip` closure per render does not detach and reattach the
  // listeners — a detach between the mousedown and the click would drop the gesture.
  const held = useRef(onSkip);
  held.current = onSkip;

  useEffect(() => {
    const element = node.current;
    if (element === null) {
      return;
    }
    const fire = (): void => {
      held.current();
    };
    element.addEventListener("click", fire, true);
    element.addEventListener("keydown", fire, true);
    return () => {
      element.removeEventListener("click", fire, true);
      element.removeEventListener("keydown", fire, true);
    };
  }, []);

  return (
    <div ref={node} data-testid="fast-forward" className={className}>
      {children}
    </div>
  );
}
