/**
 * The rail of moves: one chit per legal command, and not one decision of its own.
 *
 * ## The acceptance criterion with teeth
 *
 * `commands` is `GameView.legal_commands`, rendered **whole**. Every element appears exactly once,
 * in the engine's relative order *within its zone* (below), and every one is operable — clickable,
 * keyboard-reachable, and delivered to `onCommand` by identity. There is no `filter`, no `sort`, no
 * `slice`, no `disabled`, and no comparison of anything against anything. A command in the list is
 * legal because the engine put it there, and a command the engine did not offer cannot be
 * represented here at all — there is no code path that constructs one (ADR-005). That is why the
 * "disabled state never lies" requirement needs no vigilance in this file: the absent button is
 * the mechanism, and a disabled button is a shape the component cannot produce.
 *
 * What the bar *does* decide is **placement**, in three ways and no others:
 *
 * 1. **Grouping.** When several commands of one tile-scoped kind are legal at once — four
 *    `mortgage_property`, one per square — they collapse behind a single affordance that reveals them,
 *    and the squares offered are the squares in the legal set. `NEVER_COLLAPSED` exempts `build_house`,
 *    which stays one chit per street (MON-724). See {@link groupCommands}.
 * 2. **Zoning.** Each kind is filed under one of two labelled zones by `ACTION_THEME[kind].zone`:
 *    what the game is waiting for, then estate management. See {@link zoneCommands}.
 * 3. **Emphasis.** The estate zone is a disclosure, and it *begins open* when `emphasisFor` says the
 *    estate is the point: because of the phase, which in `DEBT_SETTLEMENT` it is, or because a
 *    `GROWTH_COMMANDS` kind is in the legal set, which is how completing a colour group announces
 *    itself (MON-724).
 *
 * All three answers come from static tables keyed on the engine's own vocabulary, evaluated against
 * nothing. **A wrong entry in any of them can move a chit or leave a zone folded; it cannot remove
 * one.** That is the whole of the difference from the property this file used to state, which was
 * about DOM order — and order was never the thing worth guaranteeing, it was a proxy for "nothing
 * was dropped". `ActionBar.test.tsx` now asserts the thing itself, over seven phases including a
 * debt-settlement position: it opens every disclosure, clicks every chit, and compares the objects
 * delivered to `onCommand` against the input set by identity. `docs/UX_ACTION_PROMINENCE.md` records
 * why, and what the alternatives cost.
 *
 * Zoning is deliberately invisible when it would be scaffolding: with only one zone occupied — the
 * purchase decision, an auction, a trade review — the bar is a flat list with no zone headings, which
 * is exactly its former rendering.
 *
 * ## Every chit is icon *and* text
 *
 * The icon comes from `ACTION_THEME`, the text from the catalogue, and neither is optional: fifteen
 * text-only labels meant a pre-reader could not use a single button (GAP G-A1/G-50). The icon is
 * `aria-hidden`, so the accessible name is the words — two channels for a child, one unambiguous
 * name for a screen reader.
 *
 * ## Terminal commands get a confirm step
 *
 * `requiresConfirmation(kind)` — the theme's predicate, not a list kept here to drift — puts a
 * dialog in front of the three commands that cannot be taken back. The dialog states the
 * consequence in plain language, opens with focus on **cancel** (a six-year-old hammering Enter
 * must not end their game), traps Tab between its two buttons, closes on Escape, and returns focus
 * to the chit that opened it (GAP C3/E1).
 *
 * ## Nothing here speaks
 *
 * No `aria-live`, no `role="status"`, no `role="alert"`. There is exactly one live region in the
 * product and it belongs to `<Announcer>` (GAP D1/G-54); a bar that narrated its own buttons would
 * be the third voice announcing one dice roll. A component that needs to say something imports
 * `useAnnounce` from `@/a11y` — this one has nothing to say that the buttons do not already say.
 *
 * *Visual direction*: the chits are counters seated in a rail, each with a die-cut well holding its
 * glyph. Terminal chits carry a torn dashed rim — the consequence class as a *shape*, because
 * `actions.ts` is explicit that a shade of red is exactly what a protan player cannot see. The
 * well is the flourish; everything around it is deliberately plain.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { BoardView, Command, Phase } from "@/api";
import { useCopy, type Copy } from "@/i18n/copy";
import {
  ACTION_THEME,
  emphasisFor,
  Icon,
  NEVER_COLLAPSED,
  requiresConfirmation,
  ZONE_ORDER,
  zoneOf,
  type ActionTheme,
  type ActionZone,
  type CommandKind,
} from "@/theme";

import { consequenceKeyFor, labelKeyFor, labelParamsFor, tileOf } from "./actionCommand";
import { EmptyState } from "./States";

import "./panels.css";

export interface ActionBarProps {
  /**
   * `GameView.legal_commands`, in the engine's order. Rendered as given.
   *
   * Typed `readonly` all the way down so that a sort or a splice in this file would not compile —
   * the cheapest possible guard on the one rule this component exists to keep.
   */
  readonly commands: readonly Command[];
  /** Submit a command. Normally `useGame().send`; the bar never awaits it. */
  readonly onCommand: (command: Command) => void;
  /** The board, for naming the square a tile-scoped command acts on. */
  readonly board: BoardView | undefined;
  /**
   * `state.ruleset.jail_fine` — the figure `action.pay_jail_fine` states.
   *
   * A projected field passed in rather than looked up, because `PayJailFine` carries no amount and
   * the bar must not decide what bail costs. See `actionCommand.ts`.
   */
  readonly jailFine: number;
  /**
   * The region's DOM id. Defaults to the id `Board`'s "skip to actions" link points at, so the two
   * line up without the caller having to know either value.
   */
  readonly id?: string;
  /**
   * Prefer the simpler wording (MON-604). `presentationFor(state.ruleset).kids`.
   *
   * Affects only which catalogue key a label resolves to — see `i18n/copy.ts`. It cannot affect
   * *which* buttons exist, because that is `commands`.
   */
  readonly kids?: boolean;
  /**
   * `ruleset.auctions_enabled` (MON-604). Selects the true `decline_purchase` consequence sentence.
   *
   * Presentation, not legality: this bar renders whatever `commands` holds either way. See
   * `consequenceKeyFor`.
   */
  readonly auctions?: boolean;
  /**
   * The one command the hint layer is pointing at, if any (MON-605).
   *
   * Compared by **identity** against the members of `commands`, so it can only ever mark a chit the
   * engine already offered — a `hinted` value from anywhere else marks nothing. It adds a rim and a
   * badge and changes nothing else: no filter, no reorder, no `disabled`. The set stays whole.
   *
   * When the marked command is inside something folded — a collapsed command group, or the estate
   * zone — the badge propagates to the affordance that hides it, so the mark is never invisible in
   * the one state a child most needs it. See {@link CommandGroupDisclosure} and {@link ZoneFold}.
   */
  readonly hinted?: Command | undefined;
  /**
   * Names the seat a command acts *for*, when that is not the seat being waited on (MON-726).
   *
   * `legal_commands` answers for every seat that may act, not only the current one — portfolio moves
   * are open in any portfolio phase (MON-204) — so on one shared screen the bar can hold two players'
   * builds at once, and before this they were indistinguishable rows. The resolver is
   * `game/seatedCommands.ts`'s `actingFor`, which is where the decision and its bounds are written
   * down.
   *
   * A resolved string per command, exactly like the square name: this file learns no more about a
   * seat than it does about a tile index. Omitted, nothing is labelled — which is right for a caller
   * with one seat's commands, and is what every existing test renders.
   */
  readonly actingFor?: ((command: Command) => string | undefined) | undefined;
  /**
   * `state.phase`, for one decision only: whether the estate zone begins open.
   *
   * `emphasisFor` reads a static table in `theme/prominence.ts`, and its output reaches exactly one
   * `useState` initial value. It cannot add, remove, filter or disable a command — the set is
   * `commands` — and the worst a wrong entry does is leave a labelled, announced, one-keystroke
   * disclosure folded. Presentation, in the sense `game/presentation.ts` sets out.
   *
   * Not the only input to that answer since MON-724: a `GROWTH_COMMANDS` kind in `commands` opens the
   * estate whatever the phase says, which is why a game that omits this prop can still arrive open.
   *
   * Omitted, the estate zone begins folded, which is the quieter presentation.
   */
  readonly phase?: Phase | undefined;
}

/** The id `Board.tsx` links to by default. Kept in step with its `actionsRegionId` default. */
export const ACTIONS_REGION_ID = "kesef-actions";

/** One kind's legal commands, in the order the engine offered them. */
interface CommandGroup {
  readonly kind: CommandKind;
  readonly commands: readonly Command[];
  /** `true` when the group must reveal its members, because each names a different square. */
  readonly collapsible: boolean;
}

/**
 * Bucket the legal commands by kind, preserving the order the engine offered them in.
 *
 * The ordering rule is "first appearance of the kind wins", so no command moves past a command of
 * a different kind and nothing is hidden by a notion of importance. A bucket collapses only when
 * it holds more than one command **and every member names a square** — which is the case the
 * grouping exists for, and is asked of the commands themselves rather than of a hand-kept list of
 * kinds that would go stale the first time a fifth tile-scoped command lands. Two `respond_to_trade`
 * commands (accept and decline) therefore stay side by side, as they must.
 *
 * `NEVER_COLLAPSED` is the one exception, and it is a list of kinds precisely because it is *not*
 * derivable from the commands: "building deserves a row per street" is a judgement about the move,
 * not a fact about its shape (MON-724). It can only ever make the bar flatter.
 */
export function groupCommands(commands: readonly Command[]): readonly CommandGroup[] {
  const order: CommandKind[] = [];
  const buckets = new Map<CommandKind, Command[]>();

  for (const command of commands) {
    const bucket = buckets.get(command.kind);
    if (bucket === undefined) {
      order.push(command.kind);
      buckets.set(command.kind, [command]);
    } else {
      bucket.push(command);
    }
  }

  return order.map((kind) => {
    const members = buckets.get(kind) ?? [];
    return {
      kind,
      commands: members,
      collapsible:
        !NEVER_COLLAPSED.has(kind) &&
        members.length > 1 &&
        members.every((member) => tileOf(member) !== undefined),
    };
  });
}

/** One zone's share of the legal set: its kind groups, and every command inside them. */
export interface CommandZone {
  readonly zone: ActionZone;
  readonly groups: readonly CommandGroup[];
  /** The zone's commands, flattened. The count the fold reports, and the reachability unit. */
  readonly commands: readonly Command[];
}

/**
 * Which zones the legal set occupies, in `ZONE_ORDER`, and what is in each.
 *
 * Two properties, both tested. **Nothing is lost**: every command lands in exactly one zone, because
 * `zoneOf` is total over the kind union by the `Record<CommandKind, …>` gate in `theme/actions.ts`.
 * And **nothing is reordered within a zone**: the members reach {@link groupCommands} in the order the
 * engine offered them, so relative order is preserved and only the *interleaving* of the two zones
 * changes — which is the whole point, since the engine's interleaving is alphabetical by kind
 * (`legality.py`'s `_sort_key`) and puts `mortgage_property` above `roll_dice`.
 *
 * An unoccupied zone is omitted rather than rendered empty, which is what lets the bar fall back to
 * a flat, heading-free list in every phase that offers turn flow alone.
 */
export function zoneCommands(commands: readonly Command[]): readonly CommandZone[] {
  return ZONE_ORDER.map((zone) => {
    const members = commands.filter((command) => zoneOf(command.kind) === zone);
    return { zone, groups: groupCommands(members), commands: members };
  }).filter((block) => block.commands.length > 0);
}

/**
 * The zones that may fold, which is the estate one and only ever the estate one.
 *
 * A set rather than a `!== "flow"` so the reason is written where the behaviour is: the flow zone is
 * *by definition* what the game is waiting for, and folding away the answer to "what now?" would be
 * the bug this whole change is trying not to introduce.
 */
const FOLDABLE_ZONES: ReadonlySet<ActionZone> = new Set<ActionZone>(["portfolio"]);

/** `actionbar.zone.flow` / `actionbar.zone.portfolio` — concatenated, like `action.<kind>`. */
export function zoneLabelKey(zone: ActionZone): string {
  return `actionbar.zone.${zone}`;
}

/** The glyph and its direction badge, in the die-cut well. Both `aria-hidden`, always. */
function ActionGlyph({ theme }: { readonly theme: ActionTheme }): React.JSX.Element {
  return (
    <span className="kesef-chit__well relative grid size-8 shrink-0 place-items-center">
      <Icon name={theme.icon} size={20} />
      {theme.modifier !== undefined && (
        <span className="border-hairline bg-tile text-ink absolute -top-1 -end-1 grid size-4 place-items-center rounded-full border">
          <Icon name={theme.modifier} size={10} />
        </span>
      )}
    </span>
  );
}

interface ChitProps {
  readonly command: Command;
  readonly label: string;
  /** The square this command acts on, already translated. Omitted when it acts on none. */
  readonly squareName?: string | undefined;
  /**
   * The seat this command acts *for*, when that is not the seat being waited on (MON-726).
   *
   * A resolved string, exactly like `squareName`: the bar is told the words, and does not learn what
   * a seat is or which one is current. Omitted for the current player's own moves, which is what
   * makes the mark mean "this one is somebody else's" rather than being on every row.
   */
  readonly actingFor?: string | undefined;
  readonly onActivate: (command: Command, trigger: HTMLButtonElement) => void;
  /**
   * Whether pressing this chit opens the confirm step — `requiresConfirmation`'s answer, passed in.
   *
   * Passed rather than computed here because the predicate needs `ruleset.auctions_enabled` and this
   * component has no business holding a ruleset flag (MON-718). It still draws the dashed terminal
   * rim from the same answer that decides the dialog, so the two cannot disagree: a chit that looks
   * final and acts otherwise is worse than either.
   */
  readonly confirms: boolean;
  /**
   * Keys the enclosing disclosure wants to see.
   *
   * On the button rather than on a wrapping `<li>` on purpose: a keydown listener belongs on
   * something that can hold focus, and inside an open group focus is always on one of these
   * buttons or on the toggle. Handling it here needs no `role` invented for a list item and no
   * lint exception.
   */
  readonly onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement> | undefined;
  /**
   * The hint's badge text, or `undefined` for a chit the hint is not pointing at (MON-605).
   *
   * Text and a rim, never colour: `panels.css`'s `.kesef-chit--hinted` draws a solid double rim,
   * which is a different *shape* from the terminal chit's dashed one and survives greyscale — the
   * same argument `actions.ts` makes about why danger is not a shade of red.
   */
  readonly hintBadge?: string | undefined;
}

/** One command, as a pressable counter. */
function Chit({
  command,
  label,
  squareName,
  actingFor,
  onActivate,
  confirms,
  onKeyDown,
  hintBadge,
}: ChitProps): React.JSX.Element {
  const theme = ACTION_THEME[command.kind];
  /*
    One sub-line, not two. "Dan · Baltic Avenue" is a single reading — whose, then which — where two
    stacked lines would push the chit past the 44 px target's comfortable height and read as two
    facts a child has to join up. The separator is a middle dot with spaces, which is direction-neutral
    and needs no logical property; a comma would be wrong in Hebrew and a slash reads as an option.
  */
  const subLine = [actingFor, squareName].filter((part) => part !== undefined).join(" · ");
  return (
    <button
      type="button"
      data-command-kind={command.kind}
      data-terminal={confirms}
      data-hinted={hintBadge !== undefined}
      onClick={(event) => {
        onActivate(command, event.currentTarget);
      }}
      onKeyDown={onKeyDown}
      className={[
        "kesef-chit",
        `kesef-chit--${theme.tone}`,
        confirms ? "kesef-chit--terminal" : "",
        hintBadge === undefined ? "" : "kesef-chit--hinted",
        "target flex w-full items-center gap-3 px-3 py-2 text-start text-sm font-semibold",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <ActionGlyph theme={theme} />
      <span className="flex min-w-0 flex-col">
        <span>{label}</span>
        {subLine !== "" && (
          <span data-testid="chit-subline" className="text-xs font-normal opacity-80">
            {subLine}
          </span>
        )}
      </span>
      {hintBadge !== undefined && (
        <span
          data-testid="hint-badge"
          className="border-hairline ms-auto shrink-0 rounded-full border px-2 py-0.5 text-[0.625rem] font-bold tracking-[0.1em] uppercase"
        >
          {hintBadge}
        </span>
      )}
    </button>
  );
}

interface GroupProps {
  readonly group: CommandGroup;
  readonly label: (command: Command) => string;
  readonly squareName: (command: Command) => string | undefined;
  /** See {@link ChitProps.actingFor}. A function, like `squareName` beside it. */
  readonly actingFor: (command: Command) => string | undefined;
  readonly onActivate: (command: Command, trigger: HTMLButtonElement) => void;
  /** See {@link ChitProps.confirms}. A function, like `label` and `hintBadge` beside it. */
  readonly confirms: (command: Command) => boolean;
  readonly t: Copy;
  /** The hint's badge for a member of this group, or `undefined`. See {@link ChitProps.hintBadge}. */
  readonly hintBadge: (command: Command) => string | undefined;
}

/**
 * A collapsed kind: one affordance that reveals the legal squares.
 *
 * The revealed rows are real buttons at the full target size, each naming its own square, because
 * "which of my four streets" is a choice a child makes by pointing at a name. It is a disclosure
 * rather than a hover reveal or a `<select>`: §5.5 forbids hover-only reveals, and a native select
 * cannot carry a colour band or an icon.
 */
function CommandGroupDisclosure({
  group,
  label,
  squareName,
  actingFor,
  onActivate,
  confirms,
  t,
  hintBadge,
}: GroupProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const theme = ACTION_THEME[group.kind];
  const first = group.commands[0];
  /*
    The hint points at one command; when that command is behind a collapsed group, the *toggle* has
    to carry the mark too or the badge is invisible until the group is opened — which is the one
    state in which a child needs the mark most. So the group is marked when it contains the hinted
    command, and the member keeps its own badge once revealed.
  */
  const hintedMember = group.commands.find((command) => hintBadge(command) !== undefined);
  const groupBadge = hintedMember === undefined ? undefined : hintBadge(hintedMember);

  /** Escape closes the group and hands focus back to the affordance that opened it (GAP E1). */
  const collapse: React.KeyboardEventHandler<HTMLButtonElement> = (event) => {
    if (event.key !== "Escape" || !open) {
      return;
    }
    event.stopPropagation();
    setOpen(false);
    toggle.current?.focus();
  };

  return (
    <li>
      <button
        type="button"
        ref={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        data-command-kind={group.kind}
        data-group="true"
        data-hinted={groupBadge !== undefined}
        onClick={() => {
          setOpen((was) => !was);
        }}
        onKeyDown={collapse}
        className={[
          "kesef-chit",
          `kesef-chit--${theme.tone}`,
          groupBadge === undefined ? "" : "kesef-chit--hinted",
          "target flex w-full items-center gap-3 px-3 py-2 text-start text-sm font-semibold",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <ActionGlyph theme={theme} />
        <span className="flex min-w-0 flex-col">
          {/* The kind's own label, unchanged — the group is a container, not a new command. */}
          <span>{first === undefined ? group.kind : label(first)}</span>
          <span className="text-xs font-normal opacity-80">
            {t("label.squares", { count: group.commands.length })}
          </span>
        </span>
        {groupBadge !== undefined && (
          <span
            data-testid="hint-badge"
            className="border-hairline ms-auto shrink-0 rounded-full border px-2 py-0.5 text-[0.625rem] font-bold tracking-[0.1em] uppercase"
          >
            {groupBadge}
          </span>
        )}
      </button>

      {open && (
        <ul id={panelId} className="border-hairline/40 mt-1 flex flex-col gap-1 border-s-2 ps-2">
          <li className="text-[0.6875rem] font-semibold tracking-[0.14em] uppercase opacity-70">
            {t("actionbar.choose_square")}
          </li>
          {group.commands.map((command, index) => (
            <li key={`${command.kind}-${String(tileOf(command) ?? index)}`}>
              <Chit
                command={command}
                label={label(command)}
                squareName={squareName(command)}
                actingFor={actingFor(command)}
                onActivate={onActivate}
                confirms={confirms(command)}
                onKeyDown={collapse}
                hintBadge={hintBadge(command)}
              />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Shared by the two zone shells: which zone, its rows, and the resolver for its label. */
interface ZoneShellProps {
  readonly zone: ActionZone;
  /** The zone's rows — `<li>`s for the chits and for any collapsed kind group. */
  readonly children: React.ReactNode;
  readonly t: Copy;
}

/** The uppercase micro-heading both zones wear, so the two read as one pair. */
const ZONE_HEADING_CLASS = "text-[0.6875rem] font-semibold tracking-[0.14em] uppercase opacity-70";

/**
 * An always-open zone: a heading, and the rows under it.
 *
 * A real `<h3>` under the bar's `<h2>` rather than a styled `<span>`, so the split is reachable by
 * heading navigation and not only by eye — the labels are the channel that makes the demotion
 * *legible* rather than merely present, which is the argument that sank a silent sort
 * (`docs/UX_ACTION_PROMINENCE.md` §2a). The `<ul>` takes its accessible name from the same heading,
 * so a screen reader announcing the list says which half of the bar it is in.
 */
function ZoneHeading({ zone, children, t }: ZoneShellProps): React.JSX.Element {
  const headingId = useId();
  return (
    <div className="flex flex-col gap-1">
      <h3 id={headingId} className={ZONE_HEADING_CLASS}>
        {t(zoneLabelKey(zone))}
      </h3>
      <ul aria-labelledby={headingId} className="flex flex-col gap-2">
        {children}
      </ul>
    </div>
  );
}

interface ZoneFoldProps extends ZoneShellProps {
  /** How many commands are inside. The engine's count, reported so the fold is not a mystery box. */
  readonly count: number;
  /** `emphasisFor` says the estate is the point. See {@link ActionBarProps.phase}. */
  readonly emphasised: boolean;
  /** The hint's badge, when the marked command is one of the ones inside. */
  readonly badge: string | undefined;
}

/**
 * A zone that folds: the estate one, and only ever that one (see `FOLDABLE_ZONES`).
 *
 * ## What makes this a fold and not a filter
 *
 * `aria-expanded` on a named affordance that reports its own contents (`4 moves`), inside an `<h3>`
 * so it is both a disclosure and a landmark for heading navigation. Nothing is `disabled` and
 * nothing is `aria-disabled` — folded is a different claim from unavailable, and this says the one it
 * means. The count comes from the legal set, so a fold can never under-report what it holds.
 *
 * ## Emphasis only ever opens
 *
 * `emphasised` seeds the initial state, and the effect below **opens and never closes**. Two
 * consequences, both deliberate:
 *
 * - A phase change cannot unmount a chit that has focus, so focus cannot fall to `<body>` — the
 *   failure this repo has shipped twice. The only thing that closes this zone is the player, using
 *   the affordance that already holds focus.
 * - A player who folds the estate away during `DEBT_SETTLEMENT` stays folded. They asked; the
 *   commands are one keystroke away and the badge still reports a hint inside.
 *
 * Escape is bound to the toggle alone, which is a smaller surface than {@link CommandGroupDisclosure}
 * gives its members and is the right one here: the toggle is where focus is after opening, and
 * binding it only there means the collapse and the focus are guaranteed to be in the same place.
 */
function ZoneFold({
  zone,
  children,
  t,
  count,
  emphasised,
  badge,
}: ZoneFoldProps): React.JSX.Element {
  const [open, setOpen] = useState(emphasised);
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Monotonic on purpose. See the docstring: the closing direction is the player's alone.
    if (emphasised) {
      setOpen(true);
    }
  }, [emphasised]);

  const collapse: React.KeyboardEventHandler<HTMLButtonElement> = (event) => {
    if (event.key !== "Escape" || !open) {
      return;
    }
    event.stopPropagation();
    setOpen(false);
    toggle.current?.focus();
  };

  return (
    <div className="flex flex-col gap-1">
      <h3>
        <button
          type="button"
          ref={toggle}
          aria-expanded={open}
          aria-controls={panelId}
          data-zone={zone}
          data-hinted={badge !== undefined}
          onClick={() => {
            setOpen((was) => !was);
          }}
          onKeyDown={collapse}
          className={`target -mx-1 flex w-full items-center gap-2 rounded-lg px-1 ${ZONE_HEADING_CLASS} hover:opacity-100`}
        >
          {/*
            Plus and minus swapped by state rather than a rotating chevron, the same choice
            `PlayerDossier`'s fold makes and for the same reason: a chevron has to point along the
            inline axis, and CSS transforms have no logical variant.
          */}
          <Icon name={open ? "minus" : "plus"} size={12} className="shrink-0" />
          <span>{t(zoneLabelKey(zone))}</span>
          <span className="tabular-nums opacity-80" dir="ltr">
            {t("actionbar.zone.moves", { count })}
          </span>
          {badge !== undefined && (
            <span
              data-testid="hint-badge"
              className="border-hairline ms-auto shrink-0 rounded-full border px-2 py-0.5 text-[0.625rem] font-bold tracking-[0.1em] uppercase"
            >
              {badge}
            </span>
          )}
        </button>
      </h3>

      {open && (
        <ul id={panelId} className="flex flex-col gap-2">
          {children}
        </ul>
      )}
    </div>
  );
}

interface ConfirmProps {
  readonly command: Command;
  readonly actionLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly t: Copy;
  /** `ruleset.auctions_enabled`. Chooses between the two true `decline_purchase` sentences. */
  readonly auctions: boolean;
}

/**
 * The confirm step for a terminal command.
 *
 * A local dialog rather than a shared `<Panel>` primitive: GAP §5 asks for one, nothing owns it
 * yet, and a sibling is building the auction and trade panels in parallel — inventing the shared
 * primitive here would be a merge conflict wearing an abstraction's clothes. It is filed as a gap
 * instead, and this dialog is small enough to be replaced by one in a single edit.
 */
function ConfirmStep({
  command,
  actionLabel,
  onConfirm,
  onCancel,
  t,
  auctions,
}: ConfirmProps): React.JSX.Element {
  const titleId = useId();
  const bodyId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const proceed = useRef<HTMLButtonElement>(null);
  // Derived, but still asked through the theme's predicate rather than unconditionally: this step
  // is only ever mounted for a command that confirms, and a `confirm.consequence.*` key for a kind
  // that has no confirm step would resolve to nothing and throw (G-F17).
  //
  // `auctions` reaches the predicate rather than the key since MON-718: declining in a game with
  // auctions switched off raises no dialog at all, so there is no longer a second sentence to pick
  // between — the one sentence this can print is true of the one ruleset that can print it.
  const consequenceKey = requiresConfirmation(command.kind, auctions)
    ? consequenceKeyFor(command.kind)
    : undefined;

  // Focus lands on cancel, not on proceed. The safe option is the default option: a player who
  // opened this by accident and presses Enter must land back where they were.
  useEffect(() => {
    cancel.current?.focus();
  }, []);

  /**
   * Escape cancels, Tab stays inside.
   *
   * Bound to the two buttons rather than to the dialog box, because the dialog box cannot hold
   * focus and a keydown listener belongs on something that can. The trap's invariant makes this
   * complete rather than merely convenient: focus enters on `cancel`, and Tab can only ever move
   * between these two, so there is no key event this misses.
   */
  const keys: React.KeyboardEventHandler<HTMLButtonElement> = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    event.preventDefault();
    const onCancelButton = event.currentTarget === cancel.current;
    // Two focusable elements, so wrapping in either direction is the same swap.
    (onCancelButton ? proceed.current : cancel.current)?.focus();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="bg-tile text-ink border-hairline flex w-full max-w-sm flex-col gap-4 rounded-2xl border p-5 shadow-[0_18px_40px_-16px_oklch(0%_0_0/0.6)]"
      >
        <h2 id={titleId} className="text-lg font-bold">
          {t("confirm.title")}
        </h2>
        <p id={bodyId} className="text-sm leading-relaxed">
          {consequenceKey === undefined ? actionLabel : t(consequenceKey)}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            ref={cancel}
            onClick={onCancel}
            onKeyDown={keys}
            data-confirm="cancel"
            className="kesef-chit kesef-chit--neutral target flex-1 px-4 py-2 text-sm font-semibold"
          >
            {t("confirm.cancel")}
          </button>
          <button
            type="button"
            ref={proceed}
            onClick={onConfirm}
            onKeyDown={keys}
            data-confirm="proceed"
            className="kesef-chit kesef-chit--danger kesef-chit--terminal target flex-1 px-4 py-2 text-sm font-semibold"
          >
            {t("confirm.proceed", { action: actionLabel })}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ActionBar({
  commands,
  onCommand,
  board,
  jailFine,
  id = ACTIONS_REGION_ID,
  kids = false,
  auctions = true,
  hinted,
  actingFor,
  phase,
}: ActionBarProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const [pending, setPending] = useState<Command | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const region = useRef<HTMLElement>(null);
  /** `true` while the keyboard is somewhere inside this bar. Maintained by the two capture handlers. */
  const held = useRef(false);

  /**
   * Catch the focus a vanishing chit drops.
   *
   * Pressing a chit changes the legal set, so the button that was pressed usually unmounts — and a
   * removed element takes focus to `<body>` with it, which is the "focus in the void" failure this
   * repo has shipped twice. It is worst on the auto-end-turn path (`game/autoEndTurn.ts`), where the
   * whole bar is replaced for the next seat without anybody having pressed anything, but it is not new
   * there and the repair belongs here rather than in the caller.
   *
   * `aria-disabled` is the pattern used where a control can *stay* — see `SkipMotionButton`. A chit
   * cannot: an absent button is how this bar says a move is unavailable, and a lingering disabled one
   * would be the ADR-005 violation the whole file exists to prevent. So the answer is the other half of
   * the same principle — put focus somewhere deliberate — and the region is exactly that somewhere,
   * because it is already `tabIndex={-1}` as the "skip to actions" link's target.
   *
   * The two guards keep it from *stealing* focus: it acts only when the bar had focus, and only when
   * focus is now on `<body>`. Removing an element fires no `blur`, which is what makes those two
   * conditions together mean "the thing that had focus is gone" rather than "the player clicked
   * elsewhere" — a click on the page background fires `focusout` and clears `held` first.
   *
   * ## `preventScroll`, and the defect it fixes (MON-729)
   *
   * **`focus()` scrolls the focused element into view.** That default is right for a focus move a
   * player *asked* for and wrong for this one, which is a repair they did not ask for and should not
   * be able to see. The bar lives in the aside column, which on a narrow screen sits below the board
   * — so every press scrolled the page down to it, reported as: *"every time we see a card the game
   * scrolls down, and we have to scroll back up."*
   *
   * It happened on **every** press, not only on cards. What made a card the thing people noticed is
   * that a card is the one thing that appears *on the board* and stays there for several seconds
   * (`cardMs`, MON-719): the player looks up to read it, and the browser has already taken them
   * somewhere else. Every other press moves the eye to the bar anyway, where the scroll is invisible.
   *
   * So the focus move stays — it is the whole point, and dropping it would put the keyboard back in
   * the void — and only the scrolling is suppressed.
   *
   * `preventScroll` degrades safely where it is not implemented: an engine that does not know the
   * option ignores it and focuses as before, which is today's behaviour rather than a broken one. So
   * there is nothing to feature-detect and no fallback to keep in step.
   */
  useEffect(() => {
    if (held.current && document.activeElement === document.body) {
      region.current?.focus({ preventScroll: true });
    }
  }, [commands]);

  // Every label and heading in the bar goes through the kids-aware resolver, which is `t` verbatim
  // outside a kids game. It changes what a button *says* and never which buttons exist.
  const copy = useCopy(kids);

  const label = useCallback(
    (command: Command) => copy(labelKeyFor(command), labelParamsFor(command, jailFine)),
    [copy, jailFine],
  );

  /**
   * The hint's badge for one command, or `undefined` (MON-605).
   *
   * Identity, not a structural comparison: `hinted` is an element of `commands`, so `===` marks the
   * chit the hint layer actually chose. Two `build_house` commands for different squares are two
   * different objects, which is exactly what makes "that one" expressible without this file learning
   * what a tile index means.
   */
  const hintBadge = useCallback(
    (command: Command): string | undefined =>
      hinted !== undefined && command === hinted ? copy("hint.badge") : undefined,
    [hinted, copy],
  );

  /**
   * The translated name of the square a command acts on.
   *
   * Same shape as `EventLog`'s lookup, and for the same reason: tile names live in a namespace per
   * board, and `board-israel` is a declared board with no catalogue until MON-503 (GAP G-46).
   * `missingKeyHandler` throws under dev and test by design, so an unguarded `t()` would take the
   * whole bar down over one missing square name — which would take away every button, including
   * the ones that work.
   */
  const squareName = useCallback(
    (command: Command): string | undefined => {
      const index = tileOf(command);
      if (index === undefined) {
        return undefined;
      }
      const tile = board?.tiles.find((candidate) => candidate.index === index);
      if (tile === undefined || board === undefined) {
        return t("label.unknown_square");
      }
      const key = `board-${board.id}:${tile.name_key}`;
      return i18n.exists(key) ? t(key) : t("label.unknown_square");
    },
    [board, t, i18n],
  );

  /**
   * The seat a command acts for, or `undefined` — the prop, or nothing when there is no prop.
   *
   * Named apart from the prop so the two cannot be confused at the call sites below, and defaulted
   * here rather than in the parameter list because a default of `() => undefined` written there is a
   * new function identity on every render, which would defeat the memo on every chit under it.
   */
  const actingForName = useCallback(
    (command: Command): string | undefined => actingFor?.(command),
    [actingFor],
  );

  /**
   * Whether a command opens the confirm step, for this table's rules (MON-718).
   *
   * One predicate, used by the branch below *and* by the chit's dashed rim, so what a chit looks like
   * and what it does cannot disagree. `auctions` is the only input beyond the kind — see
   * `requiresConfirmation`, which explains why `decline_purchase` is the one command whose answer a
   * ruleset decides.
   */
  const confirms = useCallback(
    (command: Command) => requiresConfirmation(command.kind, auctions),
    [auctions],
  );

  /**
   * A chit was pressed.
   *
   * `requiresConfirmation` is the theme's predicate and the only branch here. Everything else goes
   * straight through — the bar does not know, and must not learn, what any command does.
   */
  const activate = useCallback(
    (command: Command, from: HTMLButtonElement) => {
      if (confirms(command)) {
        trigger.current = from;
        setPending(command);
        return;
      }
      onCommand(command);
    },
    [onCommand, confirms],
  );

  const dismiss = useCallback(() => {
    setPending(null);
    trigger.current?.focus();
    trigger.current = null;
  }, []);

  const confirm = useCallback(() => {
    if (pending === null) {
      return;
    }
    const command = pending;
    setPending(null);
    trigger.current = null;
    onCommand(command);
  }, [pending, onCommand]);

  /**
   * The zones, and whether the split is worth showing.
   *
   * `zoned` is the one piece of layout that depends on the *shape* of the legal set rather than on a
   * table, and it is deliberately the mildest possible dependency: with a single zone occupied there
   * is no second zone to demote anything relative to, so two headings would be scaffolding to read
   * past. It cannot hide anything — the un-zoned branch renders the same rows in the same order.
   */
  const zones = zoneCommands(commands);
  const zoned = zones.length > 1;
  /*
    Two reasons the estate can arrive open, both `emphasisFor`'s to weigh: the phase, and a growth
    move being in the legal set (MON-724). The kinds are passed rather than the commands, so what
    reaches the table is the engine's vocabulary and not a state to compare figures against.
  */
  const emphasis = emphasisFor(
    phase,
    commands.map((command) => command.kind),
  );

  /**
   * One zone's rows: a disclosure for a collapsed tile-scoped kind, a chit for everything else.
   *
   * A function rather than a component so the closures above (`label`, `squareName`, `activate`) are
   * read directly instead of threaded through props — the rows are the same rows in all three
   * renderings, and a second copy of this mapping is how one of them would quietly lose a chit.
   */
  const rowsOf = (groups: readonly CommandGroup[]): React.ReactNode =>
    groups.map((group) =>
      group.collapsible ? (
        <CommandGroupDisclosure
          key={group.kind}
          group={group}
          label={label}
          squareName={squareName}
          actingFor={actingForName}
          onActivate={activate}
          confirms={confirms}
          t={copy}
          hintBadge={hintBadge}
        />
      ) : (
        group.commands.map((command, index) => (
          <li key={`${command.kind}-${String(tileOf(command) ?? index)}`}>
            <Chit
              command={command}
              label={label(command)}
              squareName={squareName(command)}
              actingFor={actingForName(command)}
              onActivate={activate}
              confirms={confirms(command)}
              hintBadge={hintBadge(command)}
            />
          </li>
        ))
      ),
    );

  return (
    // `tabIndex={-1}` so `Board`'s "skip to actions" link moves focus here rather than only
    // scrolling: a fragment link cannot focus a target that is not focusable.
    <section
      ref={region}
      id={id}
      tabIndex={-1}
      aria-labelledby={headingId}
      onFocusCapture={() => {
        held.current = true;
      }}
      onBlurCapture={(event) => {
        // Focus genuinely left the bar. A chit *unmounting* fires no blur at all, which is precisely
        // the case this must not clear — that is the one the effect above has to repair.
        const next = event.relatedTarget;
        if (next === null || !(next instanceof Node) || region.current?.contains(next) !== true) {
          held.current = false;
        }
      }}
      className="bg-tile text-ink border-hairline flex flex-col gap-2 rounded-2xl border p-3 shadow-[0_2px_0_0_oklch(0%_0_0/0.10),0_10px_24px_-12px_oklch(0%_0_0/0.45)]"
    >
      <h2 id={headingId} className="text-xs font-semibold tracking-[0.16em] uppercase opacity-70">
        {copy("actionbar.label")}
      </h2>

      {zones.length === 0 ? (
        // `resolve={copy}` rather than letting the shared state translate for itself: `useCopy` prefers
        // the simpler `kids.*` wording where the catalogue has a twin (MON-604), and a bar whose
        // labels are simplified above an empty state that is not would speak in two registers at once.
        <EmptyState messageKey="actionbar.none" className="py-2" resolve={copy} />
      ) : (
        zones.map((block) => {
          const rows = rowsOf(block.groups);
          if (!zoned) {
            // One zone occupied: the flat, heading-free list this bar has always been.
            return (
              <ul key={block.zone} className="flex flex-col gap-2">
                {rows}
              </ul>
            );
          }
          if (!FOLDABLE_ZONES.has(block.zone)) {
            return (
              <ZoneHeading key={block.zone} zone={block.zone} t={copy}>
                {rows}
              </ZoneHeading>
            );
          }
          const hintedMember = block.commands.find((command) => hintBadge(command) !== undefined);
          return (
            <ZoneFold
              key={block.zone}
              zone={block.zone}
              t={copy}
              count={block.commands.length}
              emphasised={emphasis === block.zone}
              badge={hintedMember === undefined ? undefined : hintBadge(hintedMember)}
            >
              {rows}
            </ZoneFold>
          );
        })
      )}

      {pending !== null && (
        <ConfirmStep
          command={pending}
          actionLabel={label(pending)}
          onConfirm={confirm}
          onCancel={dismiss}
          t={copy}
          auctions={auctions}
        />
      )}
    </section>
  );
}
