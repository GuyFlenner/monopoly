/**
 * The "hand the dice on for me" switch, in the chrome.
 *
 * Modelled on `MuteToggle` and `SkipAnimationsToggle` down to the class list: same `aria-pressed`
 * button, same `target` class for the 44 px floor, same announcement of the state it has just moved
 * to, same module-level store behind it so a second copy could not disagree. Three switches that do
 * the same kind of thing — "less of this, please" — should look and behave the same.
 *
 * `aria-pressed` reflects **the feature being on**, matching the label: "Auto end turn", pressed,
 * means turns end by themselves. That is the direction `MuteToggle` argues for — a label that is a
 * noun phrase and a pressed state that means "this is what is happening" survives translation, where
 * a verb phrase inverts the moment Hebrew renders it as a noun.
 *
 * The announcement is the one thing only this component knows; the turn change itself is narrated
 * from the event stream, and saying anything about it here would be the double-speak defect
 * (GAP D1/G-54).
 */

import { useTranslation } from "react-i18next";

import { useAnnounce } from "@/a11y";

import { useAutoEndTurnPreference } from "./autoEndTurnPreference";

export interface AutoEndTurnToggleProps {
  readonly className?: string;
}

export function AutoEndTurnToggle({ className }: AutoEndTurnToggleProps): React.JSX.Element {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const { autoEndTurn, toggle } = useAutoEndTurnPreference();

  return (
    <button
      type="button"
      aria-pressed={autoEndTurn}
      data-testid="auto-end-turn"
      onClick={() => {
        toggle();
        announce({
          politeness: "polite",
          // `autoEndTurn` is the value *before* the toggle, so the sentence describes where the press
          // just took us — the same off-by-one the other two switches get right the same way.
          key: autoEndTurn ? "a11y.auto_end_off" : "a11y.auto_end_on",
          params: {},
        });
      }}
      className={`target bg-tile text-ink border-hairline rounded-xl border px-3 py-2 text-sm font-semibold aria-pressed:font-bold ${className ?? ""}`}
    >
      {t("turn.auto_end")}
    </button>
  );
}
