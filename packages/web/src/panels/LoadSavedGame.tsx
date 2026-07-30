/**
 * "Continue a saved game" — the other half of MON-704.
 *
 * A file picker on the setup screen, because that is where a player who has just opened the tab
 * actually is. Three decisions worth reading.
 *
 * ## Why a real `<input type="file">`
 *
 * A styled `<div>` with a click handler cannot open a file dialog — that privilege belongs to the
 * input — and the pattern that works everywhere else fails here too: a `<button>` that forwards its
 * click to a hidden input loses the keyboard, because the input is what has to be focusable for
 * Space and Enter to open the dialog.
 *
 * So the input is the control, visually hidden and wrapped in a `<label>` styled as a button. This
 * is the same technique `SetupScreen`'s `Choice` radio cards use, including `has-focus-visible:` for
 * the ring — the focus lands on the input, and the outline appears on the card the player can see.
 * The label carries `min-h-11` so the 44 px floor is on the thing that gets pressed.
 *
 * ## Why nothing validates the file
 *
 * The file is parsed (it has to be, to be posted as JSON) and otherwise untouched. Whether the JSON
 * is a `GameState` and whether its `schema_version` is current are the engine's questions, answered
 * on the far side of `POST /games/load` as `error.save_schema_mismatch`. A check here would be a
 * second opinion about the engine's schema, held by the layer least able to keep it current — the
 * same argument ADR-005 makes about legality, applied to serialization.
 *
 * ## Why the input is reset after every attempt
 *
 * `value = ""` after a load, success or failure. Without it, choosing the same file twice is not a
 * `change` event, so a player whose first attempt failed for a transient reason cannot retry with
 * the file already in the dialog — the control silently does nothing on the second press.
 */

import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { asApiError, type ApiError } from "@/api";
import { readSaveFile } from "@/game/saveFile";

import { ErrorState, LoadingState } from "./States";

export interface LoadSavedGameProps {
  /**
   * Post the save. Rejects with an `ApiError` whose key this component renders — the server's
   * `error.save_schema_mismatch`, `error.game_already_exists`, `error.save_too_large` and the rest.
   */
  readonly onLoad: (save: unknown) => Promise<unknown>;
}

export function LoadSavedGame({ onLoad }: LoadSavedGameProps): React.JSX.Element {
  const { t } = useTranslation();
  const fieldId = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);

  async function chose(file: File | undefined): Promise<void> {
    if (file === undefined) {
      return; // the dialog was cancelled, which is not an attempt
    }
    setLoading(true);
    setFailure(null);
    try {
      await onLoad(await readSaveFile(file));
    } catch (cause) {
      setFailure(asApiError(cause));
    } finally {
      setLoading(false);
      if (input.current !== null) {
        input.current.value = "";
      }
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold tracking-[0.16em] uppercase opacity-70">
        {t("save.load_heading")}
      </h2>
      <label
        htmlFor={fieldId}
        className="target flex min-h-11 w-fit cursor-pointer items-center gap-2 rounded-xl border-2 border-dashed border-current/40 px-5 py-2 text-sm font-semibold has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-[oklch(70%_0.18_250)]"
      >
        <input
          id={fieldId}
          ref={input}
          type="file"
          // A hint to the dialog, not a gate: a file the picker filtered out is one the player
          // cannot choose, and a save renamed by a mail client would be unopenable. The refusal for
          // a file that is not a save belongs to `readSaveFile` and the server, where it can say why.
          accept="application/json,.json"
          disabled={loading}
          onChange={(event) => {
            void chose(event.target.files?.[0]);
          }}
          className="sr-only"
        />
        <span>{t("save.load_button")}</span>
      </label>
      <p className="text-xs opacity-70">{t("save.load_hint")}</p>
      {loading && <LoadingState messageKey="save.loading" />}
      {failure !== null && <ErrorState error={failure} headingKey="save.load_failed" />}
    </section>
  );
}
