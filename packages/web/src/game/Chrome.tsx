/**
 * The header every state of the game screen wears, so leaving is always possible.
 *
 * Moved out of `GameScreen.tsx` whole in MON-747, with its reasoning attached: the screen had grown
 * to a thousand lines and three of the components in it answered questions of their own. Nothing
 * about this one changed in the move except the `export` in front of it.
 */

import { useTranslation } from "react-i18next";

import { SCREEN_HEADING_ATTRIBUTE } from "@/a11y";
import { SkipAnimationsToggle } from "@/board";
import { LocaleSwitch } from "@/i18n/LocaleSwitch";
import { ReplayButton } from "@/replay";
import { MuteToggle } from "@/sound";
import { COMFORT_ATTRIBUTE } from "@/theme";

import { AutoEndTurnToggle } from "./AutoEndTurnToggle";
import { SaveGameButton } from "./SaveGameButton";

/**
 * The header both the loading gate and the game itself carry, so leaving is always possible.
 *
 * It is also where the comfort scale is switched (MON-604). `data-comfort="kids"` on this one box
 * raises `--kesef-target` for the whole subtree, so every `.target` control below — chits, seat
 * picker, dice toggle, the mute switch, the save button, the confirm dialog's two buttons, the trade
 * panel's cash steppers — grows together. One attribute rather than a `kids ? …` in each component,
 * because the per-component version is a list, and a list grows a hole the first time somebody adds
 * a button. Modals are inside this subtree even when they paint over it, so they inherit it too.
 */
export function Chrome({
  onLeave,
  comfort,
  autoEndTurnSwitch = false,
  children,
}: {
  readonly onLeave: () => void;
  /** `"kids"` steps the hit-target scale up; `undefined` leaves the 44 px floor in place. */
  readonly comfort?: string | undefined;
  /**
   * Offer the auto-end-turn switch.
   *
   * `false` while the first view is still in flight, because a preference about what happens after a
   * purchase is not reachable-and-useful on a loading screen, and `false` in a kids game — where the
   * feature is unconditionally on and a fourth switch would be one more thing between a six-year-old
   * and the board. See `autoEndTurn.ts`.
   */
  readonly autoEndTurnSwitch?: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      {...{ [COMFORT_ATTRIBUTE]: comfort }}
      className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-2 text-start sm:p-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        {/* `tabIndex={-1}` and the marker so the shell can land focus here when the setup screen is
            replaced by this one — see `a11y/screenFocus.ts`. Never a tab stop. */}
        <h1
          {...{ [SCREEN_HEADING_ATTRIBUTE]: "" }}
          tabIndex={-1}
          className="text-2xl font-bold tracking-tight"
        >
          {t("app.title")}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          {/* The dice tray's copy of this switch is off; the setting lives in the chrome so it is
              reachable without hunting for the board's interior. The store behind it is
              module-level, so the two cannot disagree. */}
          <SkipAnimationsToggle />
          {/* The mute switch sits beside the animation switch because they are the same kind of
              decision — "less of the flourish, please" — and a player looking for one will look
              here for the other. The store behind it is module-level (MON-706). */}
          <MuteToggle />
          {/* Third of the "less of this, please" switches, beside the other two for the same reason
              they are beside each other: a player looking for one will look here for the rest. */}
          {autoEndTurnSwitch && <AutoEndTurnToggle />}
          {/* Mid-game language change, which M5 requires to leave game state untouched. It does,
              structurally rather than by care: this control writes to i18next and the document
              element, and the game reaches this package as a projection cached by TanStack Query
              that nothing here invalidates. */}
          <LocaleSwitch />
          {/* Saving is available at any point in a game, including while the first view is still in
              flight — the file comes from the server's state, not from this screen's copy of it. */}
          <SaveGameButton />
          {/* The replay (MON-705), beside the save button because both are "what happened", not "what
              now". It fetches its own copy of the event log and renders over this screen without
              touching it, so watching turn three mid-game leaves the live board exactly where it is. */}
          <ReplayButton />
          <button
            type="button"
            onClick={onLeave}
            className="target bg-tile text-ink border-hairline rounded-xl border px-4 py-2 text-sm font-semibold"
          >
            {t("app.new_game")}
          </button>
        </div>
      </header>
      {children}
    </div>
  );
}
