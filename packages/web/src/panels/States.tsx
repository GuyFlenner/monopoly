/**
 * The three states every screen has, in one place (MON-708).
 *
 * A screen is never only its happy path. It has a moment before the data arrives, a case where
 * the data is genuinely empty, and a case where fetching it failed — and before this file the
 * product answered each of those in whichever way the component's author reached for first: a
 * `<p className="text-sm opacity-70">` here, a `<p className="py-6 text-sm opacity-70">` there,
 * one `FailureNote` with a focus trick in it, and two screens with no error branch at all. That
 * is not a style problem. Three spellings of "nothing here yet" is three places for the fourth
 * one to be a blank white panel.
 *
 * ## What these components are, and are not
 *
 * **Presentational, and keyed.** Every one takes an i18n *key*, never a sentence — the same rule
 * the engine follows (ADR-003 §6), applied to the one layer that is allowed to translate. Passing
 * text would let an English literal reach a Hebrew screen through a component whose whole job is
 * to be reused, which is the widest possible blast radius for that defect.
 *
 * **Not decisions.** Nothing here works out *whether* a list is empty or a fetch has failed. The
 * caller knows that, because the caller is what holds the query. These render it.
 *
 * ## Where the announcements go, and where they do not
 *
 * A loading state says so politely, through the one `<Announcer>` at the root — never through a
 * region of its own (GAP D1/G-54). It uses {@link useOptionalAnnounce} so that a panel's own
 * three-state test can render it without the whole app shell; see that hook for why the leniency
 * stops here.
 *
 * An error state does **not** announce. It moves focus to itself instead, which is the WCAG 3.3.1
 * answer for a rejected action and says the reason once rather than twice — the pattern
 * `SetupScreen`'s rejection and `GameScreen`'s failure note both already used, now written once.
 * That is also why there is no `role="alert"` below: this app routes urgency through the
 * Announcer's assertive channel, and a `role="alert"` here would be the second live region the
 * whole a11y layer is built to prevent.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useOptionalAnnounce } from "@/a11y";
import type { ApiError } from "@/api";
import type { Copy } from "@/i18n/copy";
import type { GroupNameScope } from "@/i18n/groupNames";
import { resolveNoteParams } from "@/panels/EventLogLines";

/** Interpolation params for a state's sentence. The same shape the Announcer carries. */
export type StateParams = Readonly<Record<string, string | number>>;

const NO_PARAMS: StateParams = {};

/**
 * How a state's key becomes a sentence, when the caller has an opinion.
 *
 * The opinion that exists is Kids Mode's: `useCopy(kids)` prefers the simpler `kids.*` twin where the
 * catalogue has one (MON-604), and a leaf rendering `t("actionbar.none")` directly would show the
 * grown-up wording inside a kids game — a screen speaking in two registers at once.
 *
 * A prop rather than `useCopy` inside these components, because whether a game is a kids game comes
 * from `presentationFor(state.ruleset)`, and a presentational leaf has no business reaching for game
 * state. It is the idiom `ActionBar`, `HintPanel` and `TurnBanner` already use: the screen resolves
 * `kids` once and passes the translator down.
 *
 * Note this is *not* the `resolve` prop MON-708 deleted from `SetupScreen`. That one threaded an
 * `i18n.exists` guard — a correctness concern, which belongs inside and is now inside
 * {@link useReasonText}. This threads a product decision the leaf genuinely cannot see.
 */
export type StateCopy = Copy;

/**
 * Turn an {@link ApiError} into a sentence.
 *
 * The server answers `{reason_key, params}` and never prose (ADR-008 §4), so rendering a failure
 * is a catalogue lookup. The `exists` guard is not defensive noise: `missingKeyHandler` throws
 * under dev and test by design, so an unguarded `t()` on a key a newer server invented would
 * replace the error message with a blank screen. The fallback is chosen by HTTP class — a 4xx is
 * a refusal, anything else did not reach the rules at all — which is transport, not a rule.
 *
 * `params` go through {@link resolveNoteParams} first, which is MON-723's half of MON-415's
 * convention: the engine sends `group_key: "group.light_blue"` rather than `"light_blue"`, and this
 * turns it into the `{{group}}` the sentence interpolates. The *same* resolver the rent notes and
 * the event log use, deliberately — a second one is how "the whole Tel Aviv set" and "the whole
 * dark blue set" end up on the same screen.
 *
 * `boardId` is optional because {@link ErrorState} renders outside a game too (a save that will not
 * load, a table that is full), and there is no board to scope a name to there. Without it a group
 * still resolves, from `common`; it just cannot be renamed by the board being played, which is why
 * an in-game caller should pass one.
 */
export function useReasonText(boardId?: string): (error: ApiError) => string {
  const { t, i18n } = useTranslation();
  const scope = useMemo<GroupNameScope>(
    () => ({
      boardId,
      translate: (key, params) => t(key, params ?? {}),
      exists: i18n.exists.bind(i18n),
    }),
    [boardId, t, i18n],
  );
  return useCallback(
    (error: ApiError) => {
      const params = resolveNoteParams(error.params, scope);
      if (i18n.exists(error.reasonKey)) {
        return t(error.reasonKey, params);
      }
      const fallback =
        error.status >= 400 && error.status < 500 ? "error.illegal_move" : "error.network";
      return t(fallback, params);
    },
    [t, i18n, scope],
  );
}

export interface EmptyStateProps {
  /** What to say. A key, so both catalogues carry it. */
  readonly messageKey: string;
  readonly params?: StateParams;
  readonly className?: string;
  /** See {@link StateCopy}. Defaults to plain `t`, which is what a screen with no kids flag wants. */
  readonly resolve?: StateCopy;
  /**
   * A hook for a test that needs *this* state rather than the words in it.
   *
   * Worth a prop rather than leaving callers to `getByText`: a state's sentence can legitimately
   * appear twice on a page — a loading state also announces itself into the polite region — and a
   * `getByText` that starts matching two nodes fails in a way that reads as a defect in the app.
   * Every one of the three carries `data-state` unconditionally as well, for a caller with none.
   */
  readonly testId?: string;
}

/**
 * A list, log or panel with nothing in it — on purpose, and not because anything went wrong.
 *
 * Deliberately quiet: an empty event log at the start of a game is the normal state of a new
 * game, and dressing it as a warning would teach a six-year-old to expect trouble on turn one.
 */
export function EmptyState({
  messageKey,
  params = NO_PARAMS,
  className = "",
  resolve,
  testId,
}: EmptyStateProps): React.JSX.Element {
  const { t } = useTranslation();
  const say = resolve ?? t;
  return (
    <p data-state="empty" data-testid={testId} className={`text-sm opacity-70 ${className}`}>
      {say(messageKey, params)}
    </p>
  );
}

export interface LoadingStateProps {
  /** Defaults to `label.loading`, which is what most waits have to say. */
  readonly messageKey?: string;
  readonly params?: StateParams;
  /**
   * Say it politely through the `<Announcer>`. On by default.
   *
   * Off for a wait that repeats — the trade builder re-validates its draft on every change, and a
   * screen reader told "checking this offer" once per keystroke is a screen reader nobody can use.
   * A wait worth narrating happens once; a wait that happens continuously is a texture, not news.
   */
  readonly announce?: boolean;
  readonly className?: string;
  /** See {@link StateCopy}. */
  readonly resolve?: StateCopy;
  /** See {@link EmptyStateProps.testId}. */
  readonly testId?: string;
}

export function LoadingState({
  messageKey = "label.loading",
  params = NO_PARAMS,
  announce = true,
  className = "",
  resolve,
  testId,
}: LoadingStateProps): React.JSX.Element {
  const { t } = useTranslation();
  const say = resolve ?? t;
  const push = useOptionalAnnounce();
  // Once per mount, per message — not once per render. A pending query re-renders its subtree for
  // reasons that have nothing to do with the wait, and each of those would be another sentence in
  // the queue. The ref rather than a `[]` dependency so a message that genuinely changes is heard.
  const said = useRef<string | null>(null);
  // `params` is read through a ref rather than depended upon: it is almost always a fresh object
  // literal, so a dependency on it would re-announce on every render.
  const heldParams = useRef(params);
  heldParams.current = params;
  useEffect(() => {
    if (!announce || said.current === messageKey) {
      return;
    }
    said.current = messageKey;
    // The *key* is pushed, not the resolved text: the Announcer translates when it speaks, so a
    // language changed mid-wait is heard in the new one. It resolves through plain `t`, which means a
    // kids game hears the grown-up wording of a wait — filed rather than fixed here, because the fix
    // is the bus carrying a resolver and that is MON-604's territory, not MON-708's.
    push({ politeness: "polite", key: messageKey, params: heldParams.current });
  }, [announce, messageKey, push]);

  return (
    <p data-state="loading" data-testid={testId} className={`text-sm opacity-80 ${className}`}>
      {say(messageKey, params)}
    </p>
  );
}

export interface ErrorStateProps {
  /**
   * The failure, as the transport reported it. Its `reason_key` is what gets rendered — see
   * {@link useReasonText}.
   */
  readonly error: ApiError;
  /** Defaults to `error.title`. A form's rejection says `setup.cannot_start` instead. */
  readonly headingKey?: string;
  /**
   * Retry, when retrying is meaningful. Omit it when it is not: a 422 rejecting a seat
   * arrangement will reject it again, and a button that changes nothing is worse than no button.
   */
  readonly onRetry?: () => void;
  readonly className?: string;
  /** See {@link EmptyStateProps.testId}. */
  readonly testId?: string;
  /**
   * The board being played, when there is one.
   *
   * Only reaches {@link useReasonText}, and only matters for a refusal naming a colour group: on
   * the Israeli board that group is a city, so "the whole Tel Aviv set" rather than "the whole dark
   * blue set" (MON-723 via `i18n/groupNames.ts`). Optional because this component also renders
   * before any game exists.
   */
  readonly boardId?: string;
}

export function ErrorState({
  error,
  headingKey = "error.title",
  onRetry,
  className = "",
  testId,
  boardId,
}: ErrorStateProps): React.JSX.Element {
  const { t } = useTranslation();
  const reasonText = useReasonText(boardId);

  return (
    <div
      data-state="error"
      data-testid={testId}
      // -1 rather than 0: the message is a focus *target*, not a tab stop. Nobody should have to
      // tab past a past failure to reach the button that retries it.
      tabIndex={-1}
      ref={(node) => {
        node?.focus();
      }}
      className={`flex flex-col items-start gap-2 rounded-xl border-s-4 border-alert bg-alert/10 p-3 text-start ${className}`}
    >
      <strong className="text-sm">{t(headingKey)}</strong>
      <p className="text-sm">{reasonText(error)}</p>
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="target bg-tile text-ink border-hairline rounded-xl border px-4 py-2 text-sm font-semibold"
        >
          {t("label.retry")}
        </button>
      )}
    </div>
  );
}
