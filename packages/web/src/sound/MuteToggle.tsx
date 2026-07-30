/**
 * The mute switch, in the chrome (MON-706).
 *
 * Modelled on `SkipAnimationsToggle` deliberately: same `aria-pressed` button, same `target` class
 * for the 44 px floor, same announcement of the state it has just moved to. Two switches that do
 * the same kind of thing should look and behave the same, and the store behind each is
 * module-level, so a second copy in a settings sheet cannot disagree with this one.
 *
 * `aria-pressed` reflects **muted**, matching the label: "Mute sound", pressed, means the game is
 * muted. The alternative — a "Sound" toggle whose pressed state means unmuted — reads correctly in
 * English and inverts the moment the label is translated as a noun, which is what Hebrew does.
 *
 * The announcement is the one thing only this component knows. The events themselves are narrated
 * from the stream; saying anything about them here would be the double-speak defect (GAP D1/G-54).
 */

import { useTranslation } from "react-i18next";

import { useAnnounce } from "@/a11y";

import { useMutePreference } from "./mute";

export interface MuteToggleProps {
  readonly className?: string;
}

export function MuteToggle({ className }: MuteToggleProps): React.JSX.Element {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const { muted, toggle } = useMutePreference();

  return (
    <button
      type="button"
      aria-pressed={muted}
      data-testid="mute-sound"
      onClick={() => {
        toggle();
        announce({
          politeness: "polite",
          // `muted` is the value *before* the toggle, so the sentence describes where the press
          // just took us — the same off-by-one `SkipAnimationsToggle` gets right the same way.
          key: muted ? "a11y.sound_on" : "a11y.sound_off",
          params: {},
        });
      }}
      className={`target bg-tile text-ink border-hairline rounded-xl border px-3 py-2 text-sm font-semibold aria-pressed:font-bold ${className ?? ""}`}
    >
      {t("sound.mute")}
    </button>
  );
}
