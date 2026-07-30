/**
 * "Save this game to a file" (MON-704).
 *
 * One button in the game chrome. It fetches `GET /games/{id}/save` and hands the bytes to the
 * player's browser; it does not render, inspect or store them — the save is the one payload that
 * carries the deck order, and a component that looked inside it would be a cheat channel with a
 * download button on it (see `saveFile.ts`).
 *
 * The button has three states, and the last of the three is the reason it is a component rather
 * than an `onClick`: a save can fail. It is a network request against a game the server may have
 * expired, and answering that with nothing at all — a button that appears not to work — is the
 * failure mode MON-708 exists to remove. So: idle, saving, and the server's own reason key.
 *
 * The failure renders **beside** the button rather than replacing it, because the retry is the
 * button, and moving focus to a message that has swallowed its own retry is a dead end.
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { asApiError, type ApiError } from "@/api";
import { ErrorState } from "@/panels/States";

import { browserSaveFilePort, saveFileContents, saveFileName, type SaveFilePort } from "./saveFile";
import { useGameContext } from "./useGame";

export interface SaveGameButtonProps {
  /** Where the file goes. Injected in tests; the browser's own download in the product. */
  readonly port?: SaveFilePort;
  readonly className?: string;
}

export function SaveGameButton({ port, className }: SaveGameButtonProps): React.JSX.Element {
  const { t } = useTranslation();
  const { client, gameId } = useGameContext();
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);

  const download = useCallback(async () => {
    setSaving(true);
    setFailure(null);
    try {
      const state = await client.saveGame(gameId);
      // `state.turn_number` rather than a counter of our own: the file is named after the moment
      // the *server* says it captured, which is the moment it will restore to.
      const target = port ?? browserSaveFilePort();
      target.save(saveFileName(gameId, state.turn_number), saveFileContents(state));
    } catch (cause) {
      setFailure(asApiError(cause));
    } finally {
      setSaving(false);
    }
  }, [client, gameId, port]);

  return (
    <>
      <button
        type="button"
        disabled={saving}
        data-testid="save-game"
        onClick={() => {
          void download();
        }}
        className={`target bg-tile text-ink border-hairline rounded-xl border px-4 py-2 text-sm font-semibold disabled:opacity-60 ${className ?? ""}`}
      >
        {saving ? t("save.saving") : t("save.download")}
      </button>
      {failure !== null && <ErrorState error={failure} className="basis-full" />}
    </>
  );
}
