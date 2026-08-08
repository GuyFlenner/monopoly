/**
 * "Continue a saved game" — the other half of MON-704, and the question MON-714 added.
 *
 * A file picker on the setup screen, because that is where a player who has just opened the tab
 * actually is. Four decisions worth reading.
 *
 * ## Why the conflict is a question and not a setting
 *
 * A save whose game is still live is refused with `error.game_already_exists` (ADR-011), and the
 * player who hit that has exactly two sensible intentions: *this is the game I was playing, put it
 * back* and *keep both*. Which one they mean is not derivable from the file, from the session, or
 * from anything the UI can see — so the refusal grows two buttons and the player answers it. The
 * answer travels as `if_exists` on the retry and nothing is remembered: the next load asks again,
 * because the next load is a different file and a different game in progress.
 *
 * The parsed file is held in state for exactly as long as that question is open. That is also why
 * the retry does not need the `<input>` — see the note about `value = ""` below, which would
 * otherwise have made a second attempt with the same file impossible.
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

import { asApiError, type ApiError, type IfExists } from "@/api";
import { readSaveFile } from "@/game/saveFile";

import { ErrorState, LoadingState } from "./States";

/** The refusal that has an answer. Every other failure is only reported. */
export const ALREADY_EXISTS_KEY = "error.game_already_exists";

export interface LoadSavedGameProps {
  /**
   * Post the save. Rejects with an `ApiError` whose key this component renders — the server's
   * `error.save_schema_mismatch`, `error.game_already_exists`, `error.save_too_large` and the rest.
   *
   * `ifExists` is the player's answer to that one refusal (ADR-011). It is `undefined` on a first
   * attempt, which is what makes the server's default — refuse, and ask — the thing that happens
   * before anybody has been asked.
   */
  readonly onLoad: (save: unknown, ifExists?: IfExists) => Promise<unknown>;
}

export function LoadSavedGame({ onLoad }: LoadSavedGameProps): React.JSX.Element {
  const { t } = useTranslation();
  const fieldId = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  /**
   * The parsed file, kept only while the conflict question is on screen.
   *
   * `null` at every other moment, including after a failure that is not a conflict: holding a
   * stranger's save in state for longer than the question it answers is how a second, unrelated
   * press would post the wrong file.
   *
   * Wrapped in an object rather than held as a bare `unknown`, so that "there is no question" and
   * "the file happens to be `null`" are different states. A JSON file containing `null` cannot reach
   * the question today — the server refuses it as a schema mismatch first — but that is a fact about
   * another package's validation order, and this component should not need it to be true.
   */
  const [contested, setContested] = useState<{ readonly save: unknown } | null>(null);

  async function attempt(save: unknown, ifExists?: IfExists): Promise<void> {
    setLoading(true);
    setFailure(null);
    setContested(null);
    try {
      await onLoad(save, ifExists);
    } catch (cause) {
      const refusal = asApiError(cause);
      setFailure(refusal);
      // The one refusal the player can answer, and only before they have answered it: a `replace`
      // or a `copy` that came back with the same key is a genuine failure, not a question to ask
      // twice.
      if (refusal.reasonKey === ALREADY_EXISTS_KEY && ifExists === undefined) {
        setContested({ save });
      }
    } finally {
      setLoading(false);
      clearInput();
    }
  }

  /** See the note above about `value = ""`. Called on every attempt, successful or not. */
  function clearInput(): void {
    if (input.current !== null) {
      input.current.value = "";
    }
  }

  /**
   * Cancel the question, and put the keyboard somewhere.
   *
   * The buttons unmount themselves, so without this the focused element vanishes and the browser
   * drops focus to `<body>` — a player who cancelled by keyboard would be silently returned to the
   * top of the tab order with nothing announced. That is MON-703's finding about `disabled`, in a
   * different shape. The picker is where focus goes because the picker is what a player does next.
   */
  function cancel(): void {
    setContested(null);
    setFailure(null);
    input.current?.focus();
  }

  async function chose(file: File | undefined): Promise<void> {
    if (file === undefined) {
      return; // the dialog was cancelled, which is not an attempt
    }
    let save: unknown;
    try {
      save = await readSaveFile(file);
    } catch (cause) {
      // Not JSON at all, so there is nothing to post and no conflict to ask about. Cleared here as
      // well as in `attempt`, because a file the player fixes and re-picks is the retry.
      setFailure(asApiError(cause));
      setContested(null);
      clearInput();
      return;
    }
    await attempt(save);
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold tracking-[0.16em] uppercase opacity-70">
        {t("save.load_heading")}
      </h2>
      <label
        htmlFor={fieldId}
        className="target flex min-h-11 w-fit cursor-pointer items-center gap-2 rounded-xl border-2 border-dashed border-current/40 px-5 py-2 text-sm font-semibold has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent"
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
      {/* `testId` so an e2e spec can read this refusal in a language it does not speak — the other
          three states in the product already carry one (`setup-error`, `game-error`, `replay-error`). */}
      {failure !== null && (
        <ErrorState error={failure} headingKey="save.load_failed" testId="load-save-error" />
      )}
      {/*
        The two answers to the one refusal that has any (MON-714, ADR-011).

        Rendered *after* the `<ErrorState>` and outside it, so the sentence the player has just been
        given is the question these answer, and so `ErrorState` keeps its one job. The focus it takes
        on mount lands on the message, and these two buttons are the next two tab stops — which is
        the order a screen reader reads them in too.

        `min-h-11` and `target` on both, because a 44 px floor applies to a control a six-year-old
        will press on a tablet whether or not it is on the game screen (`e2e/targets.spec.ts` sweeps
        every interactive element, so this is measured rather than intended).
      */}
      {contested !== null && (
        <div
          data-testid="load-save-conflict"
          className="flex flex-col items-start gap-2 rounded-xl border-s-4 border-accent bg-accent/10 p-3 text-start"
        >
          <p className="text-sm">{t("save.conflict.question")}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="load-save-replace"
              onClick={() => {
                void attempt(contested.save, "replace");
              }}
              className="target bg-tile text-ink border-hairline min-h-11 rounded-xl border px-4 py-2 text-sm font-semibold"
            >
              {t("save.conflict.replace")}
            </button>
            <button
              type="button"
              data-testid="load-save-copy"
              onClick={() => {
                void attempt(contested.save, "copy");
              }}
              className="target bg-tile text-ink border-hairline min-h-11 rounded-xl border px-4 py-2 text-sm font-semibold"
            >
              {t("save.conflict.copy")}
            </button>
            {/*
              Cancel clears the question and the refusal both. The picker underneath is what a
              player does next, and leaving the red message on screen beside an unanswered question
              would say the load is still failing when the player has decided not to make one.
            */}
            <button
              type="button"
              data-testid="load-save-cancel"
              onClick={cancel}
              className="target min-h-11 rounded-xl px-4 py-2 text-sm font-semibold underline"
            >
              {t("save.conflict.cancel")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
