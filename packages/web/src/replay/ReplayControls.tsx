/**
 * The transport controls for the replay: first, back, forward, last, and a scrub bar (MON-705).
 *
 * ## Words, not arrow glyphs
 *
 * The four buttons say "First", "Back", "Forward", "Last" rather than ◀ ▶. An arrow glyph is a
 * *physical* direction rendered as text: it points the same way in a Hebrew page, where "forward
 * along the log" runs the other way across the screen, and no `dir` attribute can turn a character
 * around. Words mean the same thing in both languages, and they are also what a screen reader would
 * have had to be told anyway.
 *
 * ## Where the arrow *keys* go, and why the slider is left alone
 *
 * The keys are handled on the buttons, and `Home`/`End` with them. Which key means "forward" comes
 * from the document's direction — `ArrowRight` in English, `ArrowLeft` in Hebrew — because that is
 * what every native slider in the browser does, and a timeline that stepped the opposite way from
 * the operating system's own controls would be wrong in exactly the way nobody reports.
 *
 * The `<input type="range">` handles its own keys, natively and locale-correctly, and this component
 * deliberately does not intercept them. It also does not *announce* its own changes: a range input
 * already speaks its `aria-valuetext` when its value moves, so pushing an announcement as well would
 * be the double-speak the whole a11y layer is built to avoid (GAP D1/G-54). The buttons and their
 * keys do announce, through the one `<Announcer>` at the root, because a button press is silent
 * otherwise.
 *
 * ## Nothing here is animated, and nothing here waits
 *
 * A step is a state change, drawn on the next frame. There is no transition to skip and therefore no
 * `prefers-reduced-motion` branch — the one honest way to satisfy that requirement.
 */

import { useCallback, useId } from "react";
import { useTranslation } from "react-i18next";

import { useAnnounce } from "@/a11y";

export interface ReplayControlsProps {
  /** How many events are folded in: `0` is before the first, `total` is the whole log. */
  readonly position: number;
  readonly total: number;
  /** Ask for a different position. Already clamped to `0…total`. */
  readonly onSeek: (position: number) => void;
}

/** One step of the four buttons, as an offset or an absolute landing place. */
interface Step {
  readonly key: string;
  readonly labelKey: string;
  /** Where this button goes, given where we are. */
  readonly to: (position: number, total: number) => number;
  /** Whether it can go anywhere from here. A button that changes nothing is disabled, not silent. */
  readonly enabled: (position: number, total: number) => boolean;
}

const STEPS: readonly Step[] = [
  {
    key: "first",
    labelKey: "replay.first",
    to: () => 0,
    enabled: (position) => position > 0,
  },
  {
    key: "back",
    labelKey: "replay.back",
    to: (position) => position - 1,
    enabled: (position) => position > 0,
  },
  {
    key: "forward",
    labelKey: "replay.forward",
    to: (position) => position + 1,
    enabled: (position, total) => position < total,
  },
  {
    key: "last",
    labelKey: "replay.last",
    to: (_position, total) => total,
    enabled: (position, total) => position < total,
  },
];

export function ReplayControls({
  position,
  total,
  onSeek,
}: ReplayControlsProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const announce = useAnnounce();
  const groupId = useId();

  /** The sentence for a position, used as the visible text, the slider's value and the narration. */
  const describe = useCallback(
    (at: number) => t("replay.position", { position: at, total }),
    [t, total],
  );

  const seek = useCallback(
    (next: number, speak: boolean) => {
      const bounded = Math.max(0, Math.min(Math.trunc(next), total));
      if (bounded === position) {
        // Nothing moved, so there is nothing to say. Announcing the position a player is already on
        // is how a step at either end of the log turns into a sentence that reads like a bug.
        return;
      }
      onSeek(bounded);
      if (speak) {
        announce({
          politeness: "polite",
          key: "replay.position",
          params: { position: bounded, total },
        });
      }
    },
    [announce, onSeek, position, total],
  );

  /**
   * Arrow keys, `Home` and `End`, mapped through the document's direction.
   *
   * Bound to the buttons rather than to a wrapper: a `<div>` carrying key handlers is either a
   * lint suppression or a role it does not deserve, and the four things a player can focus in this
   * group are already interactive elements.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const forwardKey = i18n.dir() === "rtl" ? "ArrowLeft" : "ArrowRight";
      const backKey = i18n.dir() === "rtl" ? "ArrowRight" : "ArrowLeft";
      switch (event.key) {
        case forwardKey:
          seek(position + 1, true);
          break;
        case backKey:
          seek(position - 1, true);
          break;
        case "Home":
          seek(0, true);
          break;
        case "End":
          seek(total, true);
          break;
        default:
          return;
      }
      // Only for a key this component acted on: swallowing the rest would take `Tab` and the
      // browser's own shortcuts with it.
      event.preventDefault();
    },
    [i18n, position, seek, total],
  );

  return (
    <div
      role="group"
      aria-labelledby={groupId}
      data-testid="replay-controls"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={groupId} className="text-xs font-semibold tracking-[0.16em] uppercase opacity-70">
          {t("replay.controls")}
        </p>
        {/* The position, in words, for everybody who is looking at the screen rather than listening
            to it. `dir="ltr"` is not used: the sentence is a translated sentence, not a numeral. */}
        <p data-testid="replay-position" className="text-sm font-semibold">
          {describe(position)}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {STEPS.map((step) => {
          const available = step.enabled(position, total);
          return (
            <button
              key={step.key}
              type="button"
              data-testid={`replay-${step.key}`}
              /*
                `aria-disabled`, not `disabled`, and this is a correctness fix rather than a
                preference. A `disabled` button is removed from the tab order *while focused*, so
                pressing "First" — or Home, from any of these — dropped focus onto `<body>` the moment
                the button it was on became unavailable, and the next arrow key went nowhere. The
                keyboard walk simply stopped at either end of the log, which the Playwright spec is
                what caught. `aria-disabled` says "unavailable" to a screen reader, keeps the control
                focusable, and the handler below is a no-op anyway: `seek` returns early when the
                position would not change, so the state cannot move even if the click lands.
              */
              aria-disabled={!available}
              onClick={() => {
                seek(step.to(position, total), true);
              }}
              onKeyDown={onKeyDown}
              className={`target bg-tile text-ink border-hairline rounded-xl border px-4 py-2 text-sm font-semibold ${available ? "" : "opacity-50"}`}
            >
              {t(step.labelKey)}
            </button>
          );
        })}
      </div>

      {/*
        The scrub bar. `aria-valuetext` rather than the bare number, so a screen reader hears
        "event 12 of 96" instead of "12" — the same sentence the buttons announce, from the same key.
      */}
      <input
        type="range"
        data-testid="replay-slider"
        min={0}
        max={total}
        step={1}
        value={position}
        aria-label={t("replay.slider")}
        aria-valuetext={describe(position)}
        onChange={(event) => {
          seek(Number(event.target.value), false);
        }}
        className="target w-full"
      />
    </div>
  );
}
