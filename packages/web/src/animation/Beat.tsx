/**
 * Two one-shot flourishes: a figure that pulses, and a building that pops.
 *
 * Both are driven by a **beat** — a counter from `MotionQueue` that only ever goes up. The counter
 * is the animated element's React `key`, so a bump remounts it and a remounted element replays its
 * CSS animation. That is `DiceTray`'s `Die` idiom, and it is here for the same reason: restarting an
 * animation in place needs a reflow hack, and restarting it by remounting needs nothing.
 *
 * ## Nothing is gated on any of this
 *
 * The children render whatever they were going to render, at their final value, before this
 * component consults a motion preference or a beat. There is no state in which a figure shows
 * something other than the projection's number — not briefly, not until an animation ends. The
 * flourish is a scale on a box whose contents are already correct (the same argument `DiceTray`
 * makes for the pips, GAP G-F2).
 *
 * ## Scale, never translate
 *
 * Both keyframes animate `scale` and `opacity` only. A `translateX` would have to be mirrored under
 * `dir="rtl"` and is refused by Stylelint for exactly that reason; a mark that swells in place has
 * no inline axis to get backwards, which makes the RTL-safe animation also the one that feels most
 * like a physical object.
 *
 * A duration of zero is a real value here, not a skipped branch: the player's own switch and the
 * OS's `prefers-reduced-motion` both come through `durationMs`, so a still board runs the same code
 * as a moving one (`board/motion.ts`).
 */

import type { ReactNode } from "react";

import { useMotionPreference } from "@/board/motion";

import { DEFAULT_DURATIONS } from "./timeline";

import "./animation.css";

interface BeatProps {
  /**
   * The beat from `MotionFrame`. `undefined` — or zero, which is every beat's value before anything
   * has happened — renders the children still, so a card does not pulse merely for being mounted.
   */
  readonly nonce?: number | undefined;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}

interface FlourishProps extends BeatProps {
  readonly animationClass: string;
  readonly fullMs: number;
  readonly testId: string;
}

function Flourish({
  nonce,
  children,
  className,
  animationClass,
  fullMs,
  testId,
}: FlourishProps): React.JSX.Element {
  const { durationMs } = useMotionPreference();

  // No beat at all means no animation layer is wired to this mark — a component test, a screen with
  // no game behind it — so the children are rendered exactly as they were before MON-701 existed,
  // with no wrapper element to change a layout or a query. A beat of zero *does* wrap: the layer is
  // present and this mark simply has not moved yet, and a stable box is worth more there than a
  // saved element.
  if (nonce === undefined) {
    return <>{children}</>;
  }
  const active = nonce > 0;

  return (
    <span
      // Constant while there is nothing to play, so a re-render for an unrelated reason cannot
      // replay a flourish. See the module docstring on why the key is the mechanism.
      key={nonce}
      data-testid={testId}
      data-beat={nonce}
      className={[active ? animationClass : "", className ?? ""].filter(Boolean).join(" ")}
      style={active ? ({ "--kesef-motion-ms": `${String(durationMs(fullMs))}ms` } as React.CSSProperties) : undefined}
    >
      {children}
    </span>
  );
}

/** A figure that just changed: money moving, on the dossier and in the board's interior well. */
export function Pulse({ nonce, children, className }: BeatProps): React.JSX.Element {
  return (
    <Flourish
      nonce={nonce}
      className={className}
      animationClass="kesef-pulse"
      fullMs={DEFAULT_DURATIONS.cashMs}
      testId="cash-pulse"
    >
      {children}
    </Flourish>
  );
}

/** A house or a hotel arriving on — or leaving — a square. */
export function Pop({ nonce, children, className }: BeatProps): React.JSX.Element {
  return (
    <Flourish
      nonce={nonce}
      className={className}
      animationClass="kesef-pop"
      fullMs={DEFAULT_DURATIONS.buildingMs}
      testId="building-pop"
    >
      {children}
    </Flourish>
  );
}
