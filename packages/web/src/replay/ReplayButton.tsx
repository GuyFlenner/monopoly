/**
 * "Watch the replay" — the one control that opens the viewer (MON-705).
 *
 * A button plus the panel it opens, in one component, for the same reason `SaveGameButton` is a
 * component rather than an `onClick`: the affordance and its state belong together, and the game
 * screen's job is to place it rather than to hold it. That is deliberate about the *diff* as well —
 * the screen gains one line, so nothing about the replay can conflict with work happening elsewhere
 * on the same screen.
 *
 * Whether the game is finished is not asked. A replay of a game in progress is the history of that
 * game so far, which is exactly as watchable — and reading `state.winner` here to decide would put a
 * conclusion about the *game* inside a control that has no business holding one.
 *
 * The panel is unmounted while closed, so its fetch happens when a player asks for it and its copy of
 * the log is thrown away on the way out. `ModalDialog` returns focus to this button.
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { ReplayPanel } from "./ReplayPanel";

export interface ReplayButtonProps {
  readonly className?: string;
}

export function ReplayButton({ className }: ReplayButtonProps): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  return (
    <>
      <button
        type="button"
        data-testid="open-replay"
        onClick={() => {
          setOpen(true);
        }}
        className={`target bg-tile text-ink border-hairline rounded-xl border px-4 py-2 text-sm font-semibold ${className ?? ""}`}
      >
        {t("replay.open")}
      </button>
      {open && <ReplayPanel onClose={close} />}
    </>
  );
}
