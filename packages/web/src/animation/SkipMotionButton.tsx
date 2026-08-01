/**
 * The visible "skip" affordance MON-701 asks for by name.
 *
 * Two switches now sit next to each other in the chrome and they answer different questions, which
 * is worth being explicit about because a reviewer will read one as the other:
 *
 * * `<SkipAnimationsToggle>` (`board/DiceTray.tsx`) is a **preference**, remembered in
 *   `localStorage`: "do not animate anything, ever". It collapses every duration to zero at the
 *   source.
 * * This button is an **instruction about right now**: "I have seen enough of this one, catch up".
 *   It changes no setting and is forgotten the moment the queue drains.
 *
 * ## Focusable even when there is nothing to skip
 *
 * `aria-disabled` rather than `disabled`, deliberately. A control that vanishes when its work is
 * done takes the keyboard focus with it — the player presses it, the queue drains, the button
 * unmounts, and focus falls to the document body in the middle of a turn. A control that stays put
 * and reports itself as unavailable keeps the focus ring where the player left it, and pressing it
 * while the board is still is a no-op rather than a lie. The sr-only note says which state it is in,
 * for the reader who cannot see that it is dimmed — the same treatment the dice tray gives a
 * redundant switch.
 *
 * Nothing here is announced through the `<Announcer>`. Finishing an animation changes nothing about
 * the game — every figure it was catching up to has been on screen the whole time — and a live
 * region that narrates its own controls is a region a player stops listening to (GAP G-D1/G-54).
 */

import { useTranslation } from "react-i18next";

export interface SkipMotionButtonProps {
  /** `AnimationState.playing`. Something is in flight, so there is something to catch up to. */
  readonly playing: boolean;
  readonly onSkip: () => void;
  readonly className?: string | undefined;
}

export function SkipMotionButton({
  playing,
  onSkip,
  className,
}: SkipMotionButtonProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      data-testid="skip-motion"
      data-playing={playing}
      aria-disabled={!playing}
      onClick={() => {
        if (playing) {
          onSkip();
        }
      }}
      className={[
        "target bg-tile text-ink border-hairline rounded-xl border px-3 py-2 text-sm font-semibold",
        playing ? "" : "opacity-55",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {t("motion.skip_now")}
      {!playing && <span className="sr-only"> {t("motion.nothing_moving")}</span>}
    </button>
  );
}
