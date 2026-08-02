/**
 * The game screen: eleven components, one composition, and not one rule between them.
 *
 * ## What this file is allowed to decide
 *
 * Where a component goes, and nothing else. Every fact on screen arrives through `useGame()` and
 * is handed on unexamined:
 *
 * - `legalCommands` reaches `<ActionBar>` **verbatim** — no filter, no sort, no slice, no
 *   `disabled`. That is the ADR-005 line, and it is the one thing in this file that would be
 *   worth reverting a release over. A button exists because the engine offered the command.
 * - Which panel is up comes from `state.interrupts` and nothing else. The top of the interrupt
 *   stack is the live frame (`state.py`'s `top_interrupt`), so an auction frame shows the auction
 *   and a trade frame shows the trade panel. This file never infers "an auction is probably
 *   happening" from a phase name it recognises, and it never keeps its own idea of what the table
 *   is doing — a second opinion about the phase is a rule, and it would be the one that is wrong.
 * - Every figure — cash, the turn number, the dice total — is read from the projection. There is
 *   no arithmetic in this file at all.
 *
 * ## Public holdings, on anybody's turn
 *
 * Spec §5.2: holdings are public information under the universal rules. So the dossier is not the
 * current player's card with a switch on it — it is a seat picker over `state.players` and a
 * `<PlayerDossier>` for whichever seat is chosen, on anybody's turn, with no per-seat gating. The
 * default is the acting seat because that is the one being asked to decide something.
 *
 * ## One live region, and it is not here
 *
 * There is no `aria-live`, no `role="status"` and no `role="alert"` below. `<Announcer>` at the
 * root owns both regions (GAP D1/G-54), and `useEventNarration()` is called here — once, from the
 * thing that renders a live game — to feed it. A failure is reported by moving focus to the
 * message instead, which is the WCAG 3.3.1 answer and says the reason once rather than twice.
 *
 * ## A dropped socket is not a broken game
 *
 * Losing the WebSocket loses the *push*, not the state: the view is still in the cache and a
 * command still round-trips over HTTP. So a reconnect is a quiet line of text above the board and
 * the board stays exactly where it was. Blanking the screen would be reporting a worse failure
 * than the one that happened.
 *
 * *Visual direction*: the felt table, with the board as the centrepiece and a column of painted
 * cards beside it — the moves, the wallet, the ledger. On a phone the column falls below the
 * board rather than shrinking beside it, because a 320 px board is already the whole width.
 */

import { useCallback, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useEventNarration } from "@/a11y";
import { FastForward, Pulse, SkipMotionButton, useAnimationQueue } from "@/animation";
import type { Command, PlayerView, RentQuote } from "@/api";
import {
  Board,
  describeTile,
  DiceTray,
  seatOf,
  SkipAnimationsToggle,
  Token,
  TOKEN_PX,
  type BoardMotion,
  type Translate,
} from "@/board";
import { useCopy } from "@/i18n/copy";
import { LocaleSwitch } from "@/i18n/LocaleSwitch";
import { ActionBar, ACTIONS_REGION_ID } from "@/panels/ActionBar";
import { AuctionPanel } from "@/panels/AuctionPanel";
import { CompareTray, PinToggle } from "@/panels/CompareTray";
import { EventLog } from "@/panels/EventLog";
import { noteLines } from "@/panels/EventLogLines";
import { HintPanel, RentExplanation } from "@/panels/HintPanel";
import { suggest } from "@/panels/hints";
import { PlayerDossier } from "@/panels/PlayerDossier";
import { ErrorState, LoadingState } from "@/panels/States";
import { TradeBuilder } from "@/panels/TradeBuilder";
import { TurnBanner } from "@/panels/TurnBanner";
import { ReplayButton } from "@/replay";
import { MuteToggle, useSoundCues } from "@/sound";
import { ACTION_THEME, COMFORT_ATTRIBUTE, Icon, KIDS_COMFORT } from "@/theme";

import { useAutoEndTurn } from "./autoEndTurn";
import { AutoEndTurnToggle } from "./AutoEndTurnToggle";
import { useAutoEndTurnPreference } from "./autoEndTurnPreference";
import { presentationFor, type Presentation } from "./presentation";
import { SaveGameButton } from "./SaveGameButton";
import { useUiStore } from "./uiStore";
import { useGame } from "./useGame";

export interface GameScreenProps {
  /** Leave this game and go back to the setup screen. */
  readonly onLeave: () => void;
}

/** A stable empty seat list, so the auto-advance effect's deps do not change on every render. */
const NO_PLAYERS: readonly PlayerView[] = [];

/*
 * `useReasonText` and `FailureNote` used to live here, and moved to `panels/States.tsx` in MON-708.
 * They were two of the four spellings of "render a failure" in this package, and the shared
 * `<ErrorState>` is the one that replaced all four — same catalogue lookup, same `i18n.exists`
 * guard, same focus move instead of a second live region. See that file.
 */

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
function Chrome({
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
        <h1 className="text-2xl font-bold tracking-tight">{t("app.title")}</h1>
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

/** Whose turn it is, in the board's interior well. Both figures are read, never worked out. */
function TurnSummary({
  players,
  currentId,
  turnNumber,
  cashPulse,
  t,
}: {
  readonly players: readonly PlayerView[];
  readonly currentId: number;
  readonly turnNumber: number;
  /** The animation queue's cash beat for the acting seat (MON-701). Presentation only. */
  readonly cashPulse?: number | undefined;
  /** The screen's translate, so the well's wording matches the column beside it. */
  readonly t: Translate;
}): React.JSX.Element {
  const current = players.find((player) => player.id === currentId);
  const seat = current === undefined ? undefined : seatOf(players, current.id);

  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <p className="text-[0.625rem] font-semibold tracking-[0.14em] uppercase opacity-80">
        {t("label.turn", { number: turnNumber })}
      </p>
      <p className="flex items-center gap-2 text-sm font-bold">
        {seat !== undefined && <Token seat={seat} size={TOKEN_PX.heading} isCurrent />}
        <span>{current?.name ?? String(currentId)}</span>
      </p>
      <p className="flex items-baseline gap-2 text-xs">
        <span className="opacity-80">{t("label.cash")}</span>
        {/* The figure is the projection's; the beat only decides whether it arrives with a swell. */}
        <Pulse nonce={cashPulse}>
          <span dir="ltr" className="font-bold tabular-nums">
            {current?.cash ?? 0}
          </span>
        </Pulse>
      </p>
    </div>
  );
}

/**
 * What the selected square would charge, and why (MON-420).
 *
 * Every figure is `RentQuote`'s, and the explanation is the engine's own `rent.note.*` keys
 * rendered through the same resolver the event log uses — so the sentence a player reads *before*
 * landing is assembled exactly like the one they read in the log afterwards. Two resolvers is how
 * the board and the log would end up explaining one figure differently.
 *
 * `amount` is nullable and the nullability is the point: a utility's rent is a multiple of a throw
 * that has not happened, so the engine sends no amount and `rent.note.utility_quote` says
 * "× whatever the dice show". Printing the last roll's total, or an average, would be a number
 * nothing stands behind.
 *
 * Nothing here decides whether rent is owed. A square that charges nothing quotes `null`, which is
 * why the caller renders no panel at all rather than a zero.
 */
function SquareRent({
  quote,
  t,
  kids,
}: {
  readonly quote: RentQuote;
  readonly t: Translate;
  /** Unfold the "why this much?" breakdown by default. `presentation.kids` (MON-605). */
  readonly kids: boolean;
}): React.JSX.Element {
  return (
    <span data-testid="square-rent" className="flex flex-col gap-1">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[0.625rem] font-semibold tracking-[0.14em] uppercase opacity-65">
          {t("label.rent")}
        </span>
        {quote.amount !== null && quote.amount !== undefined && (
          <span data-testid="square-rent-amount" dir="ltr" className="font-bold tabular-nums">
            {quote.amount}
          </span>
        )}
        {noteLines(quote.note_keys, quote.note_params, { translate: t }).map((note) => (
          <span key={note.key} className="text-xs opacity-75">
            {t(note.key, note.params)}
          </span>
        ))}
      </span>
      {/*
        MON-605's "why this number" affordance, on top of MON-420's sentences rather than instead of
        them: the engine's own explanation stays on screen, and the *figures* it was built from fold
        away behind a disclosure that Kids Mode opens. Nothing in there is multiplied — see
        `RentExplanation`.
      */}
      <RentExplanation quote={quote} t={t} open={kids} />
    </span>
  );
}

export function GameScreen({ onLeave }: GameScreenProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const { state, board, legalCommands, send, validate, events, status, refetch } = useGame();
  // The wire from the event stream to the one `<Announcer>`. Called here because this is the
  // component that renders a live game, and calling it twice would say every roll twice.
  useEventNarration();
  // The same wire, to the speaker (MON-706). Called here for the same reason and from the same feed,
  // so a cue and a sentence describe the same event exactly once each.
  useSoundCues();
  /*
    And the same wire to the board's motion (MON-701). Third subscriber, same feed, same rule: one
    event produces one settle, one sentence and one click.

    What comes back is an **override on presentation** and is never read to decide anything. Note
    what is *not* below: no `motion.playing &&` around the action bar, no `disabled` while a piece is
    travelling, no `await` before a command. The bar renders `legalCommands` the moment they arrive
    and `dispatch` posts immediately, so a player can act through any animation — which is
    MON-701's "nothing blocks input, ever", and it holds structurally rather than by care because
    there is nowhere in this file for a wait to be added.
  */
  const motion = useAnimationQueue();

  const playersHeadingId = useId();

  const selectedPlayer = useUiStore((ui) => ui.selectedPlayer);
  const selectPlayer = useUiStore((ui) => ui.selectPlayer);
  const selectedTile = useUiStore((ui) => ui.selectedTile);
  const selectTile = useUiStore((ui) => ui.selectTile);
  const panel = useUiStore((ui) => ui.panel);
  const openPanel = useUiStore((ui) => ui.openPanel);
  const closePanel = useUiStore((ui) => ui.closePanel);

  /** A trade offer this seat has read and put down. UI-local: the frame is still live. */
  const [dismissedTrade, setDismissedTrade] = useState<string | null>(null);

  /**
   * The two overrides the board takes, as one stable object.
   *
   * Memoised on the two maps rather than rebuilt per render, because `<Board>` keys its occupant
   * grouping off this identity — a fresh object every render would recompute forty squares' worth of
   * grouping for a keystroke in the trade panel.
   */
  const boardMotion = useMemo<BoardMotion>(
    () => ({
      positionOf: (playerId: number) => motion.tokens.get(playerId),
      popNonce: (tile: number) => motion.buildings.get(tile),
    }),
    [motion.tokens, motion.buildings],
  );

  /** The cash beat for one seat. A lookup, handed to whichever card is showing that seat. */
  const cashPulse = useCallback((playerId: number) => motion.cash.get(playerId), [motion.cash]);

  /**
   * What the rule set in force means for the screen (MON-604).
   *
   * Four presentation switches read off `state.ruleset` — see `presentation.ts` for the line between
   * "do not draw an affordance for this" and "this is not legal", which this file stays on the right
   * side of by never consulting one of these to decide what to send.
   */
  const presentation: Presentation = useMemo(() => presentationFor(state?.ruleset), [state]);

  /**
   * The command the hint layer is pointing at (MON-605).
   *
   * `legalCommands` in, one of its own elements out — so the action bar can mark it by identity and
   * this file learns nothing about what any command means. Marked only where hints are prominent:
   * under the full rules the hint is folded away, and a permanent badge would not be "quieter".
   */
  const hintedCommand = useMemo(
    () => (presentation.hintsProminent ? suggest(legalCommands)?.command : undefined),
    [presentation.hintsProminent, legalCommands],
  );

  /**
   * Post a command.
   *
   * The rejection is caught rather than left floating: the mutation already records it and
   * `status.error` is where it is rendered, so a second report would be the same failure twice.
   */
  const dispatch = useCallback(
    (command: Command) => {
      void send(command).catch(() => undefined);
    },
    [send],
  );

  /**
   * Hand the dice on after a purchase, so nobody has to press "I'm done" (owner request).
   *
   * Two things about this composition are load-bearing and neither is visible in the call:
   *
   * - **The decision is not here.** `autoEndTurn.ts` holds it, it is pure, and its entire rule is
   *   "send the `end_turn` that is in `legalCommands`, or send nothing". That guard is what gives the
   *   doubles rule, the interrupt rules and the jail rules for free — after buying on doubles the
   *   engine does not offer `end_turn`, so nothing happens and the player rolls again.
   * - **It watches the committed event log**, which is what keeps the purchase perceptible: by the
   *   time a `property_acquired` is in `events`, the animation queue, the cue player and the narrator
   *   have all had it. Chaining off `send`'s promise instead would let the second `setQueryData`
   *   overtake the first view's events and silently drop the purchase's beat and sentence.
   *
   * `presentation.kids` forces it on: fewer obligatory clicks is most of the point of a kids game, and
   * the chrome hides the switch there rather than offering a six-year-old a fourth toggle.
   */
  const { autoEndTurn: autoEndTurnPreferred } = useAutoEndTurnPreference();
  const autoEndTurnEnabled = presentation.kids || autoEndTurnPreferred;
  useAutoEndTurn({
    events,
    legalCommands,
    players: state?.players ?? NO_PLAYERS,
    enabled: autoEndTurnEnabled,
    sending: status.isSending,
    send: dispatch,
  });

  /**
   * The screen's translate.
   *
   * `useCopy` prefers the simpler `kids.*` wording where the catalogue has a twin and is exactly `t`
   * everywhere else, so a label reads more plainly in a kids game without this file holding a list
   * of which labels have been simplified (MON-604, `i18n/copy.ts`).
   */
  const translate: Translate = useCopy(presentation.kids);

  const tileName = useCallback(
    (index: number) => {
      const nameKey = board?.tiles[index]?.name_key;
      if (nameKey === undefined || board === undefined) {
        return t("label.unknown_square");
      }
      // Square names live in a namespace per board, and `missingKeyHandler` throws under dev and
      // test — the same guard the log, the bar and the dossier all carry (GAP G-46).
      const scoped = `board-${board.id}:${nameKey}`;
      return i18n.exists(scoped) ? t(scoped) : t("label.unknown_square");
    },
    [board, t, i18n],
  );

  /** The live frame is the top of the stack — the engine's own `top_interrupt`. */
  const live = state?.interrupts.at(-1);
  const auctionFrame = live?.kind === "auction" ? live : undefined;
  const tradeFrame = live?.kind === "trade" ? live : undefined;

  const tradeKey = tradeFrame === undefined ? null : JSON.stringify(tradeFrame.offer);
  const reviewingTrade = tradeKey !== null && tradeKey !== dismissedTrade;
  const draftingTrade = panel === "trade";

  const shownPlayer =
    state?.players.find((player) => player.id === (selectedPlayer ?? state.current_player_id)) ??
    state?.players[0];

  const squareNote = useMemo(() => {
    if (selectedTile === null || board === undefined || state === undefined) {
      return null;
    }
    const tile = board.tiles[selectedTile];
    if (tile === undefined) {
      return null;
    }
    const property = state.properties[selectedTile];
    const owner = property?.owner ?? null;
    return describeTile(
      {
        name: tileName(selectedTile),
        kind: tile.kind,
        ownerName:
          owner === null
            ? undefined
            : (state.players.find((player) => player.id === owner)?.name ?? String(owner)),
        houses: property?.houses ?? 0,
        mortgaged: property?.mortgaged ?? false,
        occupantNames: state.players
          .filter((player) => !player.bankrupt && player.position === selectedTile)
          .map((player) => player.name),
      },
      translate,
    );
  }, [selectedTile, board, state, tileName, translate]);

  /**
   * The rent the selected square would charge, straight off the projection.
   *
   * `state.rent_quotes` is index-aligned with `board.tiles` and priced for the seat about to act,
   * so this is a lookup and not a decision — no multiplier, no tier, no "is it owned" branch. Those
   * all live in `rules/rent.py`, which is why this field had to exist before the affordance could.
   */
  const squareQuote = selectedTile === null ? null : state?.rent_quotes[selectedTile];

  const connectionKey =
    status.connection.state === "reconnecting"
      ? "status.reconnecting"
      : status.connection.state === "closed"
        ? "status.offline"
        : null;

  // Nothing to draw yet: either the first view is still in flight, or it failed. Both keep the
  // chrome, so "New game" is reachable from a game id that no longer resolves.
  if (state === undefined || board === undefined || shownPlayer === undefined) {
    return (
      <Chrome onLeave={onLeave}>
        {status.error === undefined ? (
          <LoadingState testId="game-loading" />
        ) : (
          /*
            With a retry, since MON-708. Until now the only way out of a failed first fetch was
            "New game", which *abandons* the game the URL is pointing at — a dead end that looks like
            a decision.

            Offered whatever the status was, deliberately. Branching on it would mean this file
            deciding which failures are worth another attempt, and it is wrong about that more often
            than a player is: a 404 can be a fetch that raced a session being created, and the server
            is a great deal better placed to answer twice than this screen is to guess once.
          */
          <ErrorState error={status.error} onRetry={refetch} testId="game-error" />
        )}
      </Chrome>
    );
  }

  return (
    <Chrome
      onLeave={onLeave}
      comfort={presentation.kids ? KIDS_COMFORT : undefined}
      autoEndTurnSwitch={!presentation.kids}
    >
      {connectionKey !== null && (
        <p data-testid="connection-note" className="text-sm opacity-80">
          {t(connectionKey)}
        </p>
      )}

      {/*
        A failure with the board already on screen gets **no retry**, deliberately. What failed here
        is a command — a rejected move — and the retry for a rejected move is making a different one,
        which is the action bar. A "Try again" that re-posts a 422 would say the same thing twice.
      */}
      {status.error !== undefined && <ErrorState error={status.error} />}

      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <main className="flex min-w-0 flex-col gap-3">
          {/*
            Whose turn it is, at a size a pre-reader can follow across the room (MON-604). Above the
            board rather than inside it: the interior well is a ledger, and the answer to "is it me?"
            should not be the same size as the turn count.
          */}
          <TurnBanner
            players={state.players}
            currentId={state.current_player_id}
            turnNumber={state.turn_number}
            kids={presentation.kids}
            t={translate}
          />

          {/*
            Impatience is an instruction (MON-701). Any click or keypress inside this wrapper
            fast-forwards the timeline, in the capture phase and without swallowing the gesture — so
            the click that opened a square also finished the flourish, and the piece is on its true
            square by the time the sheet describing it appears. `<FastForward>` adds no role and no
            tab stop; the real affordance is the button below it.
          */}
          <FastForward onSkip={motion.skip}>
            <Board
              board={board}
              state={state}
              motion={boardMotion}
              actionsRegionId={ACTIONS_REGION_ID}
              onOpenTile={selectTile}
            >
              {/* The 9 x 9 interior well, which `Board` takes `children` for. */}
              <div className="flex flex-col items-center gap-2">
                <TurnSummary
                  players={state.players}
                  currentId={state.current_player_id}
                  turnNumber={state.turn_number}
                  cashPulse={cashPulse(state.current_player_id)}
                  t={translate}
                />
                {/*
                  The switch lives in the chrome, so the tray does not draw a second one. The settle
                  comes from the event stream rather than from a change in `state.dice`, which is
                  what makes two identical consecutive rolls tumble twice.
                */}
                <DiceTray dice={state.dice} withSkipToggle={false} settleNonce={motion.dice} />
              </div>
            </Board>
          </FastForward>

          {/*
            The visible skip. A different thing from the chrome's `<SkipAnimationsToggle>`: that one
            is a remembered preference, this one is "catch up, now". It stays put and reports itself
            unavailable rather than vanishing, so pressing it never drops the keyboard focus into the
            void mid-turn — see `SkipMotionButton.tsx`.
          */}
          <SkipMotionButton playing={motion.playing} onSkip={motion.skip} className="self-center" />

          {squareNote !== null && (
            <div className="bg-tile text-ink border-hairline flex flex-col gap-1 rounded-xl border p-3 text-sm">
              <p>
                <span className="me-2 text-[0.625rem] font-semibold tracking-[0.14em] uppercase opacity-65">
                  {translate("label.selected_square")}
                </span>
                {squareNote}
              </p>
              {/*
                The "explain this rent" affordance (MON-420). Absent when the square owes this seat
                nothing — the engine quotes `null` for an unowned, mortgaged or self-owned square,
                so there is no branch here about what any of those mean.
              */}
              {squareQuote !== null && squareQuote !== undefined && (
                <SquareRent quote={squareQuote} t={translate} kids={presentation.kids} />
              )}
            </div>
          )}
        </main>

        <aside className="flex min-w-0 flex-col gap-4">
          {/*
            The hint (MON-605), directly above the rail it is talking about — open in a kids game,
            folded under the full rules. It gets `legalCommands` and nothing else, so it can only ever
            point at a move the engine offered; see `panels/hints.ts`.
          */}
          <HintPanel
            commands={legalCommands}
            jailFine={state.ruleset.jail_fine}
            prominent={presentation.hintsProminent}
            kids={presentation.kids}
          />

          {/*
            `legalCommands` verbatim, and `send` as the sink. The two together are the whole of
            ADR-005 on this side of the wire.

            `kids`, `auctions` and `hinted` change what a chit *says* and how one is *marked*, and
            `phase` decides whether the estate zone arrives folded. None of the four can add or remove
            a button: the set is `commands`, unfiltered, and the hint is an element of it. See that
            file's docstring and `docs/UX_ACTION_PROMINENCE.md` for the property as it now stands.
          */}
          <ActionBar
            id={ACTIONS_REGION_ID}
            commands={legalCommands}
            onCommand={dispatch}
            board={board}
            jailFine={state.ruleset.jail_fine}
            kids={presentation.kids}
            auctions={presentation.auctions}
            hinted={hintedCommand}
            phase={state.phase}
          />

          <section aria-labelledby={playersHeadingId} className="flex flex-col gap-2">
            <h2
              id={playersHeadingId}
              className="text-xs font-semibold tracking-[0.16em] uppercase opacity-70"
            >
              {translate("dossier.all_players")}
            </h2>
            {/*
              Every seat, always — including on someone else's turn (spec §5.2, MON-406). No
              per-seat gate, because holdings are public under the universal rules.
            */}
            <div className="flex flex-wrap gap-2">
              {state.players.map((player) => {
                const seat = seatOf(state.players, player.id);
                return (
                  <button
                    key={player.id}
                    type="button"
                    aria-pressed={player.id === shownPlayer.id}
                    onClick={() => {
                      selectPlayer(player.id);
                    }}
                    className="target bg-tile text-ink border-hairline flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold aria-pressed:font-bold"
                  >
                    {seat !== undefined && <Token seat={seat} size={TOKEN_PX.inline} />}
                    <span>{player.name}</span>
                  </button>
                );
              })}
            </div>
            {/*
              The pin toggle rides in the dossier's `actions` slot, so pinning is reachable from the
              surface that is already reachable for any player at any time (spec §5.2, MON-406/702).
              The card itself learns nothing about comparing — see `CompareTray.tsx`.
            */}
            <PlayerDossier
              player={shownPlayer}
              players={state.players}
              board={board}
              properties={state.properties}
              isCurrent={shownPlayer.id === state.current_player_id}
              onSelectSquare={selectTile}
              cashPulse={cashPulse(shownPlayer.id)}
              actions={<PinToggle playerId={shownPlayer.id} name={shownPlayer.name} />}
            />

            {/*
              Offering a trade is not an enumerable command — `legality.py` never enumerates
              `ProposeTrade`, because the drafts are unbounded — so the builder needs an affordance
              of its own. It is *not* gated on `ruleset.trading_enabled`: whether a trade may be
              proposed is the engine's answer, and the validator gives it inside the panel.

              Below the property card rather than directly under the action bar, where it used to sit
              at full weight and read as a fifth move nobody makes (owner feedback, 2026-07-31). A
              trade offers the things the card above it has just listed, which is
              `docs/UX_ACTION_PROMINENCE.md`'s option (d) at the level it survives — after the card
              rather than inside it, so it makes no claim about the *seat* being shown. The glyph is
              `ACTION_THEME.propose_trade`'s own, so the icon-and-text pair every chit has had since
              MON-405 now holds for the one affordance that was still text alone.
            */}
            <button
              type="button"
              onClick={() => {
                openPanel("trade");
              }}
              className="target bg-tile text-ink border-hairline flex items-center gap-2 self-start rounded-xl border px-4 py-2 text-sm font-semibold"
            >
              <Icon name={ACTION_THEME.propose_trade.icon} size={16} aria-hidden />
              <span>{translate("action.propose_trade")}</span>
            </button>
          </section>

          <EventLog events={events} players={state.players} board={board} />
        </aside>
      </div>

      {/*
        The compare tray (MON-702), below both columns rather than inside the 22 rem aside: three
        cards side by side want the page's whole inline size, and the scroll that handles a narrower
        screen belongs to the tray's own rail. It renders nothing at all until something is pinned.
      */}
      <CompareTray
        players={state.players}
        board={board}
        properties={state.properties}
        currentPlayerId={state.current_player_id}
        onSelectSquare={selectTile}
        cashPulse={cashPulse}
      />

      {/*
        An auction is a phase, so the panel has no `onClose`: `ModalDialog` narrates
        `auction.cannot_leave` on Escape rather than dropping a player onto a board that is not
        taking commands.
      */}
      {auctionFrame !== undefined && (
        <AuctionPanel
          frame={auctionFrame}
          players={state.players}
          board={board}
          legalCommands={legalCommands}
          onSend={dispatch}
        />
      )}

      {/*
        The trade panel, in either of the two situations that call for it: a draft this seat opened,
        or an offer waiting for an answer.

        The review case used to be a known mismatch — the panel had no review mode, so it drew two
        empty trays and the answers were only reachable as chits on the bar *behind* the modal. MON-422
        closed that: passing the live `frame` puts the panel in review mode, where it renders the
        pending offer read-only with accept and decline in the footer. `frame` is `undefined` for a
        draft, which is what selects the builder.

        `onClose` stays. In review it is the way out for a player who wants to look at the board before
        answering — the offer is still on the interrupt stack, so the panel comes back.
      */}
      {(reviewingTrade || draftingTrade) && (
        <TradeBuilder
          frame={reviewingTrade ? tradeFrame : undefined}
          proposer={tradeFrame?.offer.proposer ?? state.current_player_id}
          players={state.players}
          board={board}
          simplifiedTrades={state.ruleset.simplified_trades}
          validate={validate}
          /*
            Sending closes the panel, because in both modes the panel's job is finished: a draft that
            has been proposed is no longer a draft, and an answered review has nothing left to show.

            Without this, `draftingTrade` (`panel === "trade"`) stays true after a `propose_trade`, so
            the moment the review interrupt resolves the *builder* reopens over the board with two
            empty trays. Answering a trade appeared to do nothing. A pre-existing wart the MON-422 e2e
            spec surfaced — before it, the same reopen happened after answering on the action bar and
            nothing was watching the whole round trip.

            Proposing still shows the review: `reviewingTrade` comes from the interrupt stack, not from
            the panel state, so closing the panel here cannot hide an offer that is genuinely pending.
          */
          onSend={(command) => {
            dispatch(command);
            closePanel();
          }}
          onClose={() => {
            setDismissedTrade(tradeKey);
            closePanel();
          }}
          renderDossier={(playerId) => {
            const player = state.players.find((candidate) => candidate.id === playerId);
            return player === undefined ? null : (
              <PlayerDossier
                player={player}
                players={state.players}
                board={board}
                properties={state.properties}
                isCurrent={player.id === state.current_player_id}
              />
            );
          }}
        />
      )}
    </Chrome>
  );
}
