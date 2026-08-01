/**
 * The rail of moves: one chit per legal command, and not one decision of its own.
 *
 * ## The acceptance criterion with teeth
 *
 * `commands` is `GameView.legal_commands`, rendered **verbatim**. There is no `filter`, no `sort`,
 * no `slice`, no `disabled`, and no comparison of anything against anything. A command in the list
 * is legal because the engine put it there, and a command the engine did not offer cannot be
 * represented here at all — there is no code path that constructs one (ADR-005). That is why the
 * "disabled state never lies" requirement needs no vigilance in this file: the absent button is
 * the mechanism, and a disabled button is a shape the component cannot produce.
 *
 * The one thing that is *presented* rather than listed is grouping. When several commands of one
 * tile-scoped kind are legal at once — four `build_house`, one per square — they collapse behind a
 * single affordance that reveals them. Nothing is dropped, nothing is reordered across kinds, and
 * the squares offered are the squares in the legal set. See {@link groupCommands}.
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

import type { BoardView, Command } from "@/api";
import { useCopy, type Copy } from "@/i18n/copy";
import {
  ACTION_THEME,
  Icon,
  requiresConfirmation,
  type ActionTheme,
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
   * badge and changes nothing else: no filter, no reorder, no `disabled`. The list stays verbatim.
   */
  readonly hinted?: Command | undefined;
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
      collapsible: members.length > 1 && members.every((member) => tileOf(member) !== undefined),
    };
  });
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
  readonly onActivate: (command: Command, trigger: HTMLButtonElement) => void;
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
  onActivate,
  onKeyDown,
  hintBadge,
}: ChitProps): React.JSX.Element {
  const theme = ACTION_THEME[command.kind];
  return (
    <button
      type="button"
      data-command-kind={command.kind}
      data-terminal={requiresConfirmation(command.kind)}
      data-hinted={hintBadge !== undefined}
      onClick={(event) => {
        onActivate(command, event.currentTarget);
      }}
      onKeyDown={onKeyDown}
      className={[
        "kesef-chit",
        `kesef-chit--${theme.tone}`,
        requiresConfirmation(command.kind) ? "kesef-chit--terminal" : "",
        hintBadge === undefined ? "" : "kesef-chit--hinted",
        "target flex w-full items-center gap-3 px-3 py-2 text-start text-sm font-semibold",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <ActionGlyph theme={theme} />
      <span className="flex min-w-0 flex-col">
        <span>{label}</span>
        {squareName !== undefined && (
          <span className="text-xs font-normal opacity-80">{squareName}</span>
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
  readonly onActivate: (command: Command, trigger: HTMLButtonElement) => void;
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
  onActivate,
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
                onActivate={onActivate}
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
  // is only ever mounted for a terminal command, and a `confirm.consequence.*` key for a kind that
  // has no confirm step would resolve to nothing and throw (G-F17).
  //
  // `auctions` picks the variant, because declining a purchase in a game with auctions switched off
  // does *not* send the square to auction — and a dialog that says it does teaches a rule this table
  // is not playing (MON-604).
  const consequenceKey = requiresConfirmation(command.kind)
    ? consequenceKeyFor(command.kind, auctions)
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
}: ActionBarProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const [pending, setPending] = useState<Command | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  /** The bar's own box, so a press that removes the chit has somewhere to put the keyboard. */
  const region = useRef<HTMLElement | null>(null);
  /** Armed by an activation, spent by a repair. See the effect below. */
  const pressed = useRef(false);

  /*
    Where the keyboard goes when the chit that was pressed stops existing (MON-703).

    This bar is **rebuilt from `legal_commands` after every command**, and that is the design: a button
    exists because the engine offered the command, so rolling the dice takes the roll chit away. The
    consequence nobody had accounted for is that it takes the *focus* with it — a keyboard player pressed
    Roll and was handed back to `<body>`, from where Tab starts again at the language switch, and a
    screen-reader user was told nothing at all because nothing had focus to announce. Two components in
    this package already carry a comment about the same class of bug (`SkipMotionButton`,
    `ModalDialog`); `e2e/keyboard.spec.ts` is what found this one.

    The landing place is the bar's own `<section>`, which is already focusable for the board's
    "skip to actions" link. A *container* rather than another chit, deliberately: dropping focus onto a
    live button means the next Enter — from a six-year-old who is still pressing — sends a move nobody
    chose. Tab from here continues into the bar in order.

    Three guards keep it from ever taking focus somebody wanted:

    - `pressed` is only armed by an activation, so an event arriving over the socket on somebody else's
      turn never moves this player's focus.
    - It repairs only when focus has *actually* been lost — still on the chit, or moved on deliberately,
      and this does nothing.
    - It is spent only by a repair, so an intermediate re-render that happens to leave focus intact
      cannot disarm the flag before the render that removes the chit.

    A dialog opened by the same command still wins: `<ModalDialog>` is mounted later in the tree, so its
    own focus effect runs after this one.
  */
  useEffect(() => {
    if (!pressed.current) {
      return;
    }
    const active = document.activeElement;
    if (active !== null && active !== document.body && document.body.contains(active)) {
      return;
    }
    pressed.current = false;
    region.current?.focus();
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
   * A chit was pressed.
   *
   * `requiresConfirmation` is the theme's predicate and the only branch here. Everything else goes
   * straight through — the bar does not know, and must not learn, what any command does.
   */
  const activate = useCallback(
    (command: Command, from: HTMLButtonElement) => {
      if (requiresConfirmation(command.kind)) {
        trigger.current = from;
        setPending(command);
        return;
      }
      // Arm the focus repair before posting: this is the press that may remove `from` from the document.
      pressed.current = true;
      onCommand(command);
    },
    [onCommand],
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
    // Same reason as in `activate`, and more acutely: the confirm strip unmounts as well as the chit.
    pressed.current = true;
    onCommand(command);
  }, [pending, onCommand]);

  const groups = groupCommands(commands);

  return (
    // `tabIndex={-1}` so `Board`'s "skip to actions" link moves focus here rather than only
    // scrolling: a fragment link cannot focus a target that is not focusable.
    <section
      ref={region}
      id={id}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="bg-tile text-ink border-hairline flex flex-col gap-2 rounded-2xl border p-3 shadow-[0_2px_0_0_oklch(0%_0_0/0.10),0_10px_24px_-12px_oklch(0%_0_0/0.45)]"
    >
      <h2 id={headingId} className="text-xs font-semibold tracking-[0.16em] uppercase opacity-70">
        {copy("actionbar.label")}
      </h2>

      {groups.length === 0 ? (
        // `resolve={copy}` rather than letting the shared state translate for itself: `useCopy` prefers
        // the simpler `kids.*` wording where the catalogue has a twin (MON-604), and a bar whose
        // labels are simplified above an empty state that is not would speak in two registers at once.
        <EmptyState messageKey="actionbar.none" className="py-2" resolve={copy} />
      ) : (
        <ul className="flex flex-col gap-2">
          {groups.map((group) =>
            group.collapsible ? (
              <CommandGroupDisclosure
                key={group.kind}
                group={group}
                label={label}
                squareName={squareName}
                onActivate={activate}
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
                    onActivate={activate}
                    hintBadge={hintBadge(command)}
                  />
                </li>
              ))
            ),
          )}
        </ul>
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
