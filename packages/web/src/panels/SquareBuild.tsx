/**
 * Whether a house can go on the selected square, and — when it cannot — the engine's own reason.
 *
 * ## The gap this closes
 *
 * `ActionBar`'s absent button is the mechanism (ADR-005, `UX_ACTION_PROMINENCE.md` §1.3), and it is
 * the right one: a chit that is on the bar is legal, and there is no code path that can produce a
 * lying disabled state. But absence is *silent*. A player holding a complete colour group who is ₪40
 * short of a house sees exactly what a player whose group is mortgaged sees, and exactly what a
 * player who does not hold the group sees — nothing. That was the second half of the owner's report
 * behind MON-724: *"and if I don't have money — to alert"*. See §6.6 of that document.
 *
 * ## Why this does not put a rule in the UI
 *
 * It asks. `POST /games/{id}/validate` answers `{legal, reason_key, params}` for a command without
 * applying it, which is the route `TradeBuilder` already uses to explain a refused draft (G-32), and
 * this renders the answer with nothing added to it. There is no `if cash < cost` here and there could
 * not be: this component does not know what a house costs, what a colour group is, whether the bank
 * has houses left, or what even-build means. `legality.py::_build_house` knows all four, and it is
 * the only thing that answers.
 *
 * The command *is* constructed here, which `ActionBar` may never do — and the distinction is the
 * whole of ADR-005's exception. A constructed command that is **sent** would be the UI deciding what
 * is legal. A constructed command that is only ever **validated** is the UI asking a question, and
 * `validate` is non-mutating by contract. `onSend` does not exist on this component, so the
 * difference is structural rather than a rule somebody has to remember.
 *
 * ## Why the owner is the subject
 *
 * The question is "can a house go on *this square*", so the seat asked about is the square's owner
 * rather than whoever is looking. That is not a courtesy: portfolio actions are open to every solvent
 * player in a portfolio phase (MON-204), so the owner is the seat for which the answer is meaningful
 * even on somebody else's turn. An unowned square is not asked about at all — the caller renders
 * nothing, because "why can I not build on a square nobody owns" has an answer a player already knows.
 *
 * ## One request per selection
 *
 * The ask fires when the square changes, not on a press. The owner's report was that they *could not
 * find* the answer, so an affordance they would have to discover in order to learn why they cannot
 * find something is the same defect one level down. The cost is one non-mutating request per square
 * a player opens, against `TradeBuilder`'s one per keystroke.
 *
 * A stale answer cannot be shown: every response is dropped unless the request that produced it is
 * still the current one. Selecting square 6 then 8 quickly resolves to 8's answer whichever call
 * returns first.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Command, LegalityView } from "@/api";
import type { GroupNameScope } from "@/i18n/groupNames";
import { Icon } from "@/theme";

import { resolveNoteParams } from "./EventLogLines";
import { LoadingState } from "./States";

export interface SquareBuildProps {
  /** The square being asked about. */
  readonly tile: number;
  /**
   * The seat the question is asked for — the square's owner. See the module docstring.
   *
   * The caller has already established the square is owned; a `null` owner renders no panel at all.
   */
  readonly owner: number;
  /** `useGame().validate`. Non-mutating, and the only thing here that knows a rule. */
  readonly validate: (command: Command) => Promise<LegalityView>;
  /** Scopes a colour group's name to the board being played — `error.group_incomplete` names one. */
  readonly scope: GroupNameScope;
}

/**
 * The engine's answer about one square, or `null` while the first one is in flight.
 *
 * Kept together with the tile it answers about so a render can never pair square 8 with square 6's
 * verdict — the state is one object, so the two cannot be updated out of step.
 */
interface Verdict {
  readonly tile: number;
  readonly view: LegalityView;
}

export function SquareBuild({ tile, owner, validate, scope }: SquareBuildProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const [verdict, setVerdict] = useState<Verdict | null>(null);

  useEffect(() => {
    let current = true;
    /*
      Constructed, never sent. See the module docstring: this object exists to be asked about, and
      the component has no sink to send it to.
    */
    const command: Command = { kind: "build_house", player: owner, tile };
    void validate(command)
      .then((view) => {
        if (current) {
          setVerdict({ tile, view });
        }
      })
      .catch(() => {
        // A failed *question* is not worth a red panel on the board: the player still has the square's
        // name, its rent and its owner. Staying at `null` renders the quiet wait, which is honest —
        // nothing is known — and the next selection asks again.
        if (current) {
          setVerdict(null);
        }
      });
    return () => {
      current = false;
    };
  }, [tile, owner, validate]);

  const answer = verdict !== null && verdict.tile === tile ? verdict.view : null;

  /**
   * The sentence, resolved once.
   *
   * `resolveNoteParams` is MON-415's `*_key` convention and MON-723's half of it: the engine sends
   * `group_key: "group.dark_blue"` and this turns it into the `{{group}}` the sentence interpolates,
   * so the Israeli board renames the set for free — "the whole **Tel Aviv** set". The same resolver
   * the rent notes, the event log and the trade seal use; a second one is how one screen ends up
   * explaining a group two ways.
   *
   * The `exists` guard is the one in `useReasonText` and is here for the same reason:
   * `missingKeyHandler` throws under dev and test, so an unguarded `t()` on a key a newer engine
   * invented would replace the panel with a blank screen.
   */
  const sentence = useMemo(() => {
    if (answer === null || answer.legal) {
      return null;
    }
    const key = answer.reason_key;
    const params = resolveNoteParams(answer.params, scope);
    if (key === null || key === undefined) {
      return t("build.refused");
    }
    return i18n.exists(key) ? t(key, params) : t("build.refused");
  }, [answer, scope, t, i18n]);

  if (answer === null) {
    // `announce={false}`: a player moving across the board opens several squares, and a screen reader
    // told "checking" once per square is a screen reader nobody can use. Same argument as the trade
    // seal's, and the same prop.
    return (
      <LoadingState
        messageKey="build.checking"
        announce={false}
        className="text-xs"
        testId="square-build-checking"
      />
    );
  }

  return (
    <p
      data-testid="square-build"
      data-legal={answer.legal}
      className="flex items-start gap-2 text-xs"
    >
      <Icon name={answer.legal ? "check" : "cross"} size={14} aria-hidden />
      <span>
        <span className="me-2 text-[0.625rem] font-semibold tracking-[0.14em] uppercase opacity-65">
          {t("build.label")}
        </span>
        {answer.legal ? t("build.ready") : sentence}
      </span>
    </p>
  );
}
