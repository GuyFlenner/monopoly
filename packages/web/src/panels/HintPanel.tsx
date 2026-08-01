/**
 * The hint: which decision is on the table, why, and where the rent figure came from (MON-605).
 *
 * ## It has no button, and that is the design
 *
 * The obvious shape for a hint is a big "do this" button. This panel deliberately does not have
 * one, for two reasons that both matter more than the convenience:
 *
 * 1. **A second path to a command is a second path around the confirm step.** `declare_bankruptcy`,
 *    `decline_purchase` and `withdraw_from_auction` reach the engine only through the action bar's
 *    `ConfirmStep` (MON-405). A shortcut here would be a one-tap route past the dialog that exists
 *    because a six-year-old hammering Enter must not end their game. `Hint.terminal` is surfaced by
 *    `hints.ts` precisely so this file could have made that mistake and did not.
 * 2. **Two buttons for one move is clutter, which is the thing Kids Mode is removing.** MON-604's
 *    whole argument is that an unreachable or duplicated affordance is noise to a child. So the
 *    hint *names* the move and the bar *is* the move: the matching chit is marked `data-hinted` and
 *    carries a visible badge, and the two sit adjacent in the same column.
 *
 * ## Nothing here is a rule, and nothing here is a strategy
 *
 * The ranking is `hints.ts`'s, over `legal_commands` alone — see that module for the argument. This
 * file adds a heading, a sentence and a disclosure. It does no arithmetic at all: the rent
 * breakdown prints `RentQuote`'s own fields side by side and never multiplies two of them together,
 * because the product of `base_rent` and `multiplier` is `rules/rent.py`'s answer and `amount` is
 * where it is already published.
 *
 * ## One live region, and it is not here
 *
 * No `aria-live`. The suggestion is pushed to the root `<Announcer>` through `useAnnounce()` as two
 * polite drafts — the action, then the reason — which is exactly the two sentences on screen, so
 * the spoken and the printed hint cannot drift. It speaks only where the hint is *open*: narrating
 * the contents of a folded disclosure would be announcing something that is not on screen.
 *
 * *Visual direction*: a torn-off note tucked above the rail of moves — hairline rim, one indented
 * quote. Quiet on purpose: it is advice, not an instrument.
 */

import { useEffect, useId, useMemo, useRef } from "react";

import { useAnnounce } from "@/a11y";
import type { Command, RentQuote } from "@/api";
import { useCopy, type Copy } from "@/i18n/copy";
import { Icon } from "@/theme";

import { labelKeyFor, labelParamsFor } from "./actionCommand";
import { iconFor, suggest } from "./hints";

import "./panels.css";

export interface HintPanelProps {
  /** `GameView.legal_commands`, unmodified. The only input the ranking gets. */
  readonly commands: readonly Command[];
  /** `state.ruleset.jail_fine` — the figure `action.pay_jail_fine` states. See `actionCommand.ts`. */
  readonly jailFine: number;
  /**
   * Render open on the page rather than folded behind a disclosure.
   *
   * `presentationFor(state.ruleset).hintsProminent`, which is `ruleset.hints_enabled` — on in Kids
   * Mode, off under the full rules, where hints stay available but quiet.
   */
  readonly prominent: boolean;
  /** Prefer the simpler wording. `presentationFor(state.ruleset).kids`. */
  readonly kids: boolean;
}

export function HintPanel({
  commands,
  jailFine,
  prominent,
  kids,
}: HintPanelProps): React.JSX.Element {
  const copy = useCopy(kids);
  const announce = useAnnounce();
  const headingId = useId();

  const hint = useMemo(() => suggest(commands), [commands]);
  const actionLabel =
    hint === null ? null : copy(labelKeyFor(hint.command), labelParamsFor(hint.command, jailFine));

  /**
   * Say the hint once per change, and only where it is visible.
   *
   * The signature guard is what stops a re-render re-announcing the same advice: a view refetch
   * produces a new `legal_commands` array with the same contents, so identity is not the question —
   * what changed for a listener is the sentence.
   */
  const said = useRef<string | null>(null);
  useEffect(() => {
    if (!prominent || hint === null || actionLabel === null) {
      said.current = null;
      return;
    }
    const signature = `${hint.reasonKey}|${actionLabel}`;
    if (said.current === signature) {
      return;
    }
    said.current = signature;
    announce([
      { politeness: "polite", key: "hint.suggestion", params: { action: actionLabel } },
      { politeness: "polite", key: hint.reasonKey, params: {} },
    ]);
  }, [prominent, hint, actionLabel, announce]);

  const body =
    hint === null || actionLabel === null ? (
      <p data-testid="hint-empty" className="text-sm opacity-75">
        {copy("hint.none")}
      </p>
    ) : (
      <>
        <p data-testid="hint-suggestion" className="flex items-center gap-2 text-sm font-semibold">
          <Icon name={iconFor(hint.command.kind)} size={18} className="shrink-0 opacity-80" />
          <span>{copy("hint.suggestion", { action: actionLabel })}</span>
        </p>
        <p
          data-testid="hint-reason"
          className="border-current/25 border-s-2 ps-2 text-sm leading-relaxed opacity-85"
        >
          {copy(hint.reasonKey)}
        </p>
      </>
    );

  if (prominent) {
    return (
      <section
        data-testid="hint-panel"
        data-prominent="true"
        aria-labelledby={headingId}
        className="bg-tile text-ink border-hairline flex flex-col gap-2 rounded-2xl border p-3"
      >
        <h2 id={headingId} className="text-xs font-semibold tracking-[0.16em] uppercase opacity-70">
          {copy("hint.title")}
        </h2>
        {body}
      </section>
    );
  }

  /*
    Folded, under the full rules. A native `<details>` rather than a `useState` toggle and a store
    slice: it is keyboard-operable, exposed to a screen reader as an expandable group, findable by
    in-page search while closed, and it holds its own state — none of which a div with an `onClick`
    gets for free, and none of which is game state that the server could ever disagree with.
  */
  return (
    <details
      data-testid="hint-panel"
      data-prominent="false"
      className="bg-tile text-ink border-hairline rounded-2xl border px-3 py-2"
    >
      <summary className="target -mx-1 flex cursor-pointer items-center gap-2 rounded-lg px-1 text-xs font-semibold tracking-[0.16em] uppercase opacity-70 hover:opacity-100">
        {copy("hint.show")}
      </summary>
      <div className="mt-2 flex flex-col gap-2">{body}</div>
    </details>
  );
}

export interface RentExplanationProps {
  /** `state.rent_quotes[tile]` — the engine's own quote for the selected square (MON-420). */
  readonly quote: RentQuote;
  /** The translate to use. `useCopy(kids)`'s, so the wording matches the rest of the screen. */
  readonly t: Copy;
  /** Start unfolded. Kids Mode does; the full rules leave it on demand. */
  readonly open: boolean;
}

/**
 * "Why this much?" — the figures behind a rent, on demand.
 *
 * Every row is one field of `RentQuote` printed beside its label, and there is deliberately no row
 * that is the *product* of two others: `amount` is already the engine's answer and lives in the
 * panel above this one. A `base_rent × multiplier` line here would be the UI recomputing rent, and
 * it would be the line that disagrees with the charge the first time a rule changes.
 *
 * A row is omitted when it has nothing to say — no multiplier of one, no dice total for a rent that
 * did not use the dice. That is a presentation filter over projected numbers, in the same family as
 * the dossier's `houses > 0 &&`, and not a decision about what applies: the engine decides that and
 * says so in `note_keys`, which the panel above renders in full.
 */
export function RentExplanation({ quote, t, open }: RentExplanationProps): React.JSX.Element {
  const rows: readonly { readonly key: string; readonly value: number }[] = [
    { key: "hint.rent.base", value: quote.base_rent },
    ...(quote.houses > 0 ? [{ key: "hint.rent.houses", value: quote.houses }] : []),
    ...(quote.multiplier === 1 ? [] : [{ key: "hint.rent.multiplier", value: quote.multiplier }]),
    ...(quote.dice_total === null || quote.dice_total === undefined
      ? []
      : [{ key: "hint.rent.dice_total", value: quote.dice_total }]),
  ];

  return (
    <details data-testid="rent-explanation" open={open} className="mt-1">
      <summary className="target -mx-1 flex w-fit cursor-pointer items-center gap-2 rounded-lg px-1 text-xs font-semibold opacity-75 hover:opacity-100">
        {t("hint.explain_rent")}
      </summary>
      <p className="mt-1 text-[0.625rem] font-semibold tracking-[0.14em] uppercase opacity-65">
        {t("hint.rent.title")}
      </p>
      <dl className="mt-1 flex flex-col gap-0.5">
        {rows.map((row) => (
          <div key={row.key} className="flex items-baseline gap-2 text-xs">
            <dt className="opacity-75">{t(row.key)}</dt>
            {/* `dir="ltr"` keeps Latin numerals reading left to right inside a Hebrew line (G-43). */}
            <dd dir="ltr" className="font-bold tabular-nums">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
