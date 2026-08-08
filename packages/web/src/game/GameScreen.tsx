/**
 * The game screen: eleven components, one composition, and not one rule between them.
 *
 * ## What this file is allowed to decide
 *
 * Where a component goes, and nothing else. Every fact on screen arrives through `useGame()` and
 * is handed on unexamined:
 *
 * - `legalCommands` reaches `<ActionBar>` with **one filter and no other change** — no sort, no
 *   slice, no `disabled`, nothing reordered. A button still exists because the engine offered the
 *   command, which is the ADR-005 line and the thing in this file worth reverting a release over.
 *
 *   The filter is `movesAtThisScreen`, added by MON-726, and it is worth reading in full before
 *   touching: it drops the **estate** moves of **bot** seats and nothing else. `legal_commands`
 *   answers for every seat that may act rather than for the seat being waited on (MON-204), so it
 *   carries the builds and mortgages of every solvent player — and a bot's estate is played by
 *   `bots.py`, so offering it here was three rows of trap on one shared screen. Turn flow is never
 *   filtered, whoever it belongs to, so no value of `players` can hide the move the game is waiting
 *   on. The narrowing is an owner decision (2026-08-06) and is stated and tested in
 *   `seatedCommands.ts`; what is left over is labelled with the seat it acts for rather than hidden.
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
 * ## Four of the pieces are siblings now (MON-747)
 *
 * `Chrome`, `TurnSummary`, `SquareRent` and the connection note were declared above this component
 * and are now `./Chrome`, `./TurnSummary`, `./SquareRent` and `./ConnectionNote`. The move was
 * exactly that — the bodies, their props and their docstrings are the lines that were deleted from
 * here, so `git diff -M` shows them as renames rather than as rewrites. Nothing about what the
 * screen decides changed, because the answer to "what does this file decide" is still the paragraph
 * at the top: where a component goes, and nothing else.
 *
 * *Visual direction*: the felt table, with the board as the centrepiece and a column of painted
 * cards beside it — the moves, the wallet, the ledger. On a phone the column falls below the
 * board rather than shrinking beside it, because a 320 px board is already the whole width.
 */

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useEventNarration } from "@/a11y";
import { FastForward, SkipMotionButton, useAnimationQueue } from "@/animation";
import type { Command, PlayerView } from "@/api";
import {
  Board,
  describeTile,
  DiceTray,
  seatOf,
  Token,
  TOKEN_PX,
  type BoardMotion,
  type Translate,
} from "@/board";
import { useCopy } from "@/i18n/copy";
import type { GroupNameScope } from "@/i18n/groupNames";
import { ActionBar, ACTIONS_REGION_ID } from "@/panels/ActionBar";
import { AuctionPanel } from "@/panels/AuctionPanel";
import { CardReveal } from "@/panels/CardReveal";
import { CompareTray, PinToggle } from "@/panels/CompareTray";
import { EventLog } from "@/panels/EventLog";
import { HintPanel } from "@/panels/HintPanel";
import { suggest } from "@/panels/hints";
import { PlayerDossier } from "@/panels/PlayerDossier";
import { SquareBuild } from "@/panels/SquareBuild";
import { ErrorState, LoadingState } from "@/panels/States";
import { TradeBuilder } from "@/panels/TradeBuilder";
import { TurnBanner } from "@/panels/TurnBanner";
import { useSoundCues } from "@/sound";
import { ACTION_THEME, Icon, KIDS_COMFORT } from "@/theme";

import { endTurnAfterDecline, useAutoEndTurn } from "./autoEndTurn";
import { useAutoEndTurnPreference } from "./autoEndTurnPreference";
import { Chrome } from "./Chrome";
import { ConnectionNote } from "./ConnectionNote";
import { presentationFor, type Presentation } from "./presentation";
import { actingFor, movesAtThisScreen } from "./seatedCommands";
import { SquareRent } from "./SquareRent";
import { TurnSummary } from "./TurnSummary";
import { useUiStore } from "./uiStore";
import { useGame } from "./useGame";
import { useMoney } from "@/i18n";

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

export function GameScreen({ onLeave }: GameScreenProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const money = useMoney();
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
  /*
    Where the focus goes when the card reveal leaves the screen (MON-709).

    The card is transient by design — it is dismissed, skipped, or it simply times out — and a control
    that vanishes with the focus inside it drops that focus onto `<body>` in the middle of a turn. The
    skip button is the natural landing place: always mounted, directly under the board, and about the
    same thing the card's dismiss control is about. See `CardReveal.tsx` and `SkipMotionButton.tsx`.
  */
  const skipButtonRef = useRef<HTMLButtonElement | null>(null);

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
   * The moves belonging to the people at this screen, and the resolver naming whose each one is
   * (MON-726).
   *
   * `legal_commands` answers for every seat that *may* act rather than for the seat being waited on
   * (MON-204), so it carries the estate moves of every solvent player — including the bots, whose
   * estates `bots.py` already plays. `movesAtThisScreen` drops those and nothing else; `actingFor`
   * marks what is left with the seat it acts for. The reasoning, and the bound that keeps turn flow
   * out of it, are in `seatedCommands.ts`.
   *
   * Both feed the bar **and** the hint, deliberately: a hint pointing at a move the bar does not
   * offer is worse than no hint, and "build on Dan's street" was never advice worth giving.
   */
  const seatedCommands = useMemo(
    () => movesAtThisScreen(legalCommands, state?.players ?? []),
    [legalCommands, state?.players],
  );
  const actingForSeat = useMemo(
    () => actingFor(state?.players ?? [], state?.current_player_id ?? -1),
    [state?.players, state?.current_player_id],
  );

  /**
   * The command the hint layer is pointing at (MON-605).
   *
   * `seatedCommands` in, one of its own elements out — so the action bar can mark it by identity and
   * this file learns nothing about what any command means. Marked only where hints are prominent:
   * under the full rules the hint is folded away, and a permanent badge would not be "quieter".
   */
  const hintedCommand = useMemo(
    () => (presentation.hintsProminent ? suggest(seatedCommands)?.command : undefined),
    [presentation.hintsProminent, seatedCommands],
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

  /**
   * Post a command, and hand the dice on if the command was "no thanks" (owner request).
   *
   * The rejection is caught rather than left floating: the mutation already records it and
   * `status.error` is where it is rendered, so a second report would be the same failure twice.
   *
   * The follow-through reads the **response**, which is the view the engine returned, and asks it
   * whether `end_turn` is now on offer for that seat. That is the whole decision and it lives in
   * `endTurnAfterDecline` — including why a decline needs this route while a purchase is served by the
   * log-watching hook below, and why neither an auctions check nor a doubles check belongs here.
   *
   * Chained rather than awaited into a second `dispatch`, so a failed decline cannot produce an
   * `end_turn`: `then` only runs on the accepted one.
   */
  const dispatch = useCallback(
    (command: Command) => {
      void send(command)
        .then((view) => {
          const follow = endTurnAfterDecline(command, view, autoEndTurnPreferred);
          if (follow !== null) {
            void send(follow).catch(() => undefined);
          }
        })
        .catch(() => undefined);
    },
    [send, autoEndTurnPreferred],
  );

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

  /**
   * The screen's translate plus the board whose catalogue may name a colour group.
   *
   * On the Israeli board each colour group is a city and its squares are streets in it, so the band
   * is "תל אביב" and not "כחול כהה". Built once here and handed to everything below that prints a
   * group's name, so no two panels on this screen can disagree about what a group is called — see
   * `i18n/groupNames.ts`.
   */
  const groupScope = useMemo<GroupNameScope>(
    () => ({ boardId: board?.id, translate, exists: i18n.exists.bind(i18n) }),
    [board?.id, translate, i18n],
  );

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

  /**
   * A seat's display name. A lookup in the projection, the same one `useEventNarration` makes.
   *
   * The fallback is the id rather than an invented name, so a seat this screen has not been told
   * about shows up as a number to investigate instead of as plausible text.
   */
  const playerName = useCallback(
    (playerId: number) =>
      state?.players.find((player) => player.id === playerId)?.name ?? String(playerId),
    [state],
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

  /**
   * The selected square and its owner, when there is a building question worth asking (MON-725).
   *
   * Two projected facts, both read and neither derived: `tile.kind` is board data, and `owner` is
   * `PropertyView`'s own field. No rule is evaluated here — see the comment at the render site, and
   * `SquareBuild`'s docstring for why the *answer* is the engine's alone.
   */
  const squareBuild = useMemo(() => {
    if (selectedTile === null || board === undefined || state === undefined) {
      return null;
    }
    const tile = board.tiles[selectedTile];
    const owner = state.properties[selectedTile]?.owner ?? null;
    if (tile?.kind !== "property" || owner === null) {
      return null;
    }
    return { tile: selectedTile, owner };
  }, [selectedTile, board, state]);

  // Nothing to draw yet: either the first view is still in flight, or it failed. Both keep the
  // chrome, so "New game" is reachable from a game id that no longer resolves.
  if (state === undefined || board === undefined || shownPlayer === undefined) {
    return (
      <Chrome onLeave={onLeave}>
        {/*
          The `<main>` is MON-703's finding. These two placeholders are the whole content of the
          screen while a game is loading or has failed to load, and they sat as bare children of the
          chrome — outside every landmark, which axe reports as `region`. The board's own `<main>`
          below is the same landmark for the same reason; there is only ever one of them on screen,
          because this branch returns.
        */}
        <main>
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
        </main>
      </Chrome>
    );
  }

  return (
    // Both sides of this line arrived at once: MON-711 added the auto-end-turn switch to the chrome,
    // and MON-703 moved the connection note and the command failure *out* of the chrome and into
    // `<main>` below, because as bare children they sat outside every landmark. Both are kept — the
    // switch is chrome, the two sentences are the game's.
    <Chrome
      onLeave={onLeave}
      comfort={presentation.kids ? KIDS_COMFORT : undefined}
      autoEndTurnSwitch={!presentation.kids}
    >
      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <main className="flex min-w-0 flex-col gap-3">
          {/*
            The connection note and the command failure moved *inside* `<main>` in MON-703. They were
            bare children of the chrome, which put the only two sentences a player gets about a
            dropped socket or a refused move outside every landmark — axe's `region` rule, and a
            screen-reader user navigating by landmark would never reach them. They belong to the game
            rather than to the chrome, so `<main>` is where they go; `<aside>` has to stay a sibling
            of `<main>` (a complementary landmark nested in another landmark is its own axe finding),
            which is why the pair moved into the column rather than the grid moving into a `<main>`.
          */}
          <ConnectionNote connection={status.connection} />

          {/*
            A failure with the board already on screen gets **no retry**, deliberately. What failed
            here is a command — a rejected move — and the retry for a rejected move is making a
            different one, which is the action bar. A "Try again" that re-posts a 422 would say the
            same thing twice.
          */}
          {status.error !== undefined && <ErrorState error={status.error} boardId={board.id} />}

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
          {/*
            The board and the card layer share one positioning context, and the card is deliberately
            a **sibling of** `<FastForward>` rather than a child of it (MON-709).

            That is a keyboard matter, not a layout preference. `<FastForward>` fast-forwards on any
            keydown in its subtree, so a dismiss button inside it could never be reached: pressing Tab
            to get there would finish the timeline and take the card away first. Outside it, tabbing to
            the card works, and a click on the *board* still fast-forwards — which is the behaviour
            MON-701 asked for and this does not touch.
          */}
          <div className="relative">
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
                    money={money}
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
              The card a player has just drawn (MON-709), over the board for as long as the queue
              holds the beat.

              `motion.card` is the animation frame's own field, so this is presentation lag and
              nothing else: it is `null` whenever the queue is idle, and there is no `state` field
              behind it to disagree with. Note what is *not* here — no gate on the action bar, no
              `disabled`, no `await`. The layer is `pointer-events-none` except for the card itself,
              so the squares underneath stay clickable and a player can act straight through the
              reveal.

              Dismissing is `motion.skip`, deliberately the same call the skip button makes: "put
              this card down" and "catch up" are one instruction, and a second mechanism with a timer
              of its own is how two clocks end up disagreeing about what is on screen.
            */}
            {motion.card !== null && (
              <CardReveal
                card={motion.card}
                playerName={playerName(motion.card.player)}
                kids={presentation.kids}
                onDismiss={motion.skip}
                returnFocusRef={skipButtonRef}
              />
            )}
          </div>

          {/*
            The visible skip. A different thing from the chrome's `<SkipAnimationsToggle>`: that one
            is a remembered preference, this one is "catch up, now". It stays put and reports itself
            unavailable rather than vanishing, so pressing it never drops the keyboard focus into the
            void mid-turn — see `SkipMotionButton.tsx`.
          */}
          <SkipMotionButton
            playing={motion.playing}
            onSkip={motion.skip}
            buttonRef={skipButtonRef}
            className="self-center"
          />

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
                <SquareRent
                  quote={squareQuote}
                  scope={groupScope}
                  kids={presentation.kids}
                  money={money}
                />
              )}
              {/*
                Whether a house can go here, and the engine's own reason when it cannot (MON-725).

                The condition is two projected facts and no rule: the square is a `property`, and
                somebody owns it. Everything that decides *buildability* — the colour group, the
                mortgage flag, the bank's stock, even-build, the cash — is asked of `validate` inside
                the component, because those are `_build_house`'s five checks and not this file's.

                An unowned square is not asked about: "you cannot build on a square nobody owns" is
                the one answer a player already has, and it would appear on every square they open
                while looking for somewhere to land.
              */}
              {squareBuild !== null && (
                <SquareBuild
                  tile={squareBuild.tile}
                  owner={squareBuild.owner}
                  validate={validate}
                  scope={groupScope}
                />
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
            commands={seatedCommands}
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
            commands={seatedCommands}
            onCommand={dispatch}
            actingFor={actingForSeat}
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
