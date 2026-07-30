/**
 * Building a two-sided offer, without knowing a single trade rule.
 *
 * ## The validator is the authority, and it is the *only* authority
 *
 * There is no trade rule in this file. Not "you cannot trade a property with houses on the
 * group", not the `simplified_trades` one-item limit, not solvency, not "you must own what you
 * are offering". Every draft is posted to `POST /games/{id}/validate` through `useGame().validate`
 * and the answer — `{legal, reason_key, params}` — is rendered (G-32). That route exists for
 * exactly this component: `legality.py` delegates trade legality to `is_legal`, and before the
 * route existed the only options were to fire speculative commands and read the 422s, or to
 * reimplement the rules in TypeScript.
 *
 * Two consequences worth stating, because both look like bugs until you see the reason:
 *
 * - **The cash boxes are not capped at what a player holds.** Offering more cash than you have is
 *   a rule violation, and rule violations are the validator's to report, not the form's to
 *   prevent. Capping the box would be `if cash < offered` in the UI. The boxes stop at zero,
 *   which is not a rule — a negative side is not an offer at all.
 * - **`simplified_trades` hides nothing.** Kids mode gets a sentence saying one item per side is
 *   the limit, and a draft that breaks it is rejected *by the engine*, with the engine's key. If a
 *   later change wants to grey out the second checkbox as a kindness, that is fine as
 *   presentation — but the validator stays the thing that decides, so this file never grows a
 *   count-the-items conditional that has to agree with the ruleset.
 *
 * ## What the form *is* allowed to decide
 *
 * That an offer has been written at all. An empty draft is engine-legal (MON-101 resolution 5) and
 * the send button is still hidden until one side carries something — nothing-for-nothing spam is
 * not a rule violation, it is an unfinished form, and in Kids Mode it is a way to jam the table
 * (the MON-410 amendment). Same distinction the setup screen draws about an empty name box.
 *
 * ## No dragging
 *
 * Selection is a checkbox, a button or Enter — never a drag, a double-click, a long-press or a
 * hover reveal (spec §5.5, GAP C2). Dragging is the hardest interaction there is for a
 * six-year-old, for a tremor and for a keyboard, and it is the one a trade screen reaches for
 * first. Checkbox lists cost nothing and work for everybody.
 *
 * ## The dossiers are somebody else's component
 *
 * Spec §5.2's compare case wants both sides' holdings visible while building. `<PlayerDossier>`
 * is MON-406's file, so this panel takes a render prop and calls it for each side rather than
 * drawing a second opinion of the same thing.
 *
 * *Visual direction — two trays and a seal.* Two facing trays of warm stock, one per side, each
 * headed by whose things are in it. Between them, on the spine, the validator's answer as a
 * stamped seal: a check when the offer can be sent, a cross and the engine's own sentence when it
 * cannot. The verdict is the centre of the composition rather than a toast at the edge, because
 * "why can't I send this?" is the question this screen exists to answer.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type {
  BoardView,
  Command,
  CommandOfKind,
  InterruptFrameView,
  LegalityView,
  PlayerView,
} from "@/api";
import { seatOf, Token, TOKEN_PX } from "@/board";
import { Icon } from "@/theme";

import { ModalDialog } from "./ModalDialog";
import { EmptyState, LoadingState } from "./States";

/** The offer and its two halves, taken off the command union rather than restated. */
export type TradeOffer = CommandOfKind<"propose_trade">["offer"];
export type TradeSide = TradeOffer["give"];

/**
 * The trade frame, narrowed out of the interrupt union rather than restated.
 *
 * Same shape of declaration as `AuctionPanel`'s `AuctionFrameView`, and for the same reason: the
 * projection owns the fields, so restating them here would create a second opinion about what a
 * pending trade contains.
 */
export type TradeFrameView = Extract<InterruptFrameView, { kind: "trade" }>;
/** Which pack a Get Out of Jail card came from. Off `PlayerView`, so it cannot drift. */
export type Deck = PlayerView["jail_cards"][number];

/** One side of the table, as the form holds it. */
interface SideDraft {
  readonly cash: number;
  readonly tiles: readonly number[];
  readonly jailCards: readonly Deck[];
}

const EMPTY_SIDE: SideDraft = { cash: 0, tiles: [], jailCards: [] };

/** How much one press moves a cash box. One step, because the box itself covers the rest. */
const CASH_STEP = 10;

/** How long to sit on a draft before asking the server about it. */
export const VALIDATE_DEBOUNCE_MS = 150;

function isSideEmpty(side: SideDraft): boolean {
  return side.cash === 0 && side.tiles.length === 0 && side.jailCards.length === 0;
}

function toWire(side: SideDraft): TradeSide {
  return { cash: side.cash, tiles: [...side.tiles], jail_cards: [...side.jailCards] };
}

function toggle<T>(list: readonly T[], item: T): readonly T[] {
  return list.includes(item) ? list.filter((each) => each !== item) : [...list, item];
}

export interface TradeBuilderProps {
  /**
   * A live trade-review frame, when there is one. Present ⇒ **review mode** (MON-422).
   *
   * The defect this closes: with no `frame`, a review rendered the *draft* form — two empty trays and
   * a recipient picker — so the one panel built to show an offer showed everything except the offer.
   * Accept and decline were only reachable as `respond_to_trade` chits on the action bar *behind* the
   * modal, which is to say the recipient could not see what they were agreeing to.
   *
   * Absent ⇒ draft mode, unchanged and still the default.
   */
  readonly frame?: TradeFrameView | undefined;
  /** Who is making the offer. The panel builds `propose_trade` on their behalf. */
  readonly proposer: number;
  /** Seat order, names, holdings. The only source of what either side can put up. */
  readonly players: readonly PlayerView[];
  /** The only source of a property's name. */
  readonly board: BoardView;
  /**
   * `ruleset.simplified_trades`, for the explanatory sentence only.
   *
   * Deliberately not wired to any control: the validator decides, and a form that enforced the
   * limit itself would be a second implementation of it. See the module docstring.
   */
  readonly simplifiedTrades?: boolean;
  /** `useGame().validate`. Non-mutating, and the only thing that says whether a draft is legal. */
  readonly validate: (command: Command) => Promise<LegalityView>;
  readonly onSend: (command: Command) => void;
  readonly onClose?: (() => void) | undefined;
  /**
   * Both sides' holdings, side by side, while building (spec §5.2).
   *
   * A slot rather than a component, because `<PlayerDossier>` belongs to MON-406. Called once per
   * side with that side's player id. Omitted in tests and until the dossier is wired in; nothing
   * fake is drawn in its place.
   */
  readonly renderDossier?: ((playerId: number) => ReactNode) | undefined;
}

/**
 * The panel, in whichever of its two modes the table is in.
 *
 * A dispatch rather than a branch inside one body, because the two modes share almost nothing: review
 * has no draft state, no debounce, no validator call and no recipient to choose — it renders a frame
 * the engine already accepted. Threading `frame === undefined` through a dozen hooks would make every
 * one of them answer a question it does not care about.
 */
export function TradeBuilder(props: TradeBuilderProps): React.JSX.Element {
  return props.frame === undefined ? (
    <TradeDraft {...props} />
  ) : (
    <TradeReview
      frame={props.frame}
      players={props.players}
      board={props.board}
      onSend={props.onSend}
      onClose={props.onClose}
      renderDossier={props.renderDossier}
    />
  );
}

function TradeDraft({
  proposer,
  players,
  board,
  simplifiedTrades = false,
  validate,
  onSend,
  onClose,
  renderDossier,
}: TradeBuilderProps): React.JSX.Element {
  const { t } = useTranslation();

  const others = useMemo(
    () => players.filter((player) => player.id !== proposer && !player.bankrupt),
    [players, proposer],
  );
  const [recipient, setRecipient] = useState<number | null>(others[0]?.id ?? null);
  const [give, setGive] = useState<SideDraft>(EMPTY_SIDE);
  const [receive, setReceive] = useState<SideDraft>(EMPTY_SIDE);
  const [verdict, setVerdict] = useState<LegalityView | null>(null);
  const [checking, setChecking] = useState(false);

  const draftEmpty = isSideEmpty(give) && isSideEmpty(receive);

  const command = useMemo<Command | null>(
    () =>
      recipient === null
        ? null
        : {
            kind: "propose_trade",
            player: proposer,
            offer: {
              proposer,
              recipient,
              give: toWire(give),
              receive: toWire(receive),
            },
          },
    [give, proposer, receive, recipient],
  );

  // A string rather than the object, so the effect fires when the *offer* changes and not merely
  // because a render built a new object with the same contents in it.
  const signature = command === null ? "" : JSON.stringify(command);

  /**
   * Ask the engine about the current draft.
   *
   * Debounced, because tapping `+10` four times is four drafts and only the last one is a
   * question worth asking. The generation guard is what makes it safe: a slow answer to an old
   * draft is discarded rather than rendered against the new one, which is the difference between
   * a stale verdict and a wrong one.
   */
  useEffect(() => {
    if (command === null || draftEmpty) {
      setVerdict(null);
      setChecking(false);
      return;
    }
    let live = true;
    setChecking(true);
    const timer = setTimeout(() => {
      void validate(command)
        .then((answer) => {
          if (live) {
            setVerdict(answer);
            setChecking(false);
          }
        })
        .catch(() => {
          // A transport failure is not a verdict. Saying "illegal" here would put words in the
          // engine's mouth, so the panel simply has no answer yet and the send stays shut.
          if (live) {
            setVerdict(null);
            setChecking(false);
          }
        });
    }, VALIDATE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `signature` stands in for `command`: same content, stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, draftEmpty, validate]);

  const playerName = useCallback(
    (id: number) => players.find((player) => player.id === id)?.name ?? String(id),
    [players],
  );

  const tileName = useCallback(
    (index: number) => {
      const nameKey = board.tiles[index]?.name_key;
      return nameKey === undefined ? String(index) : t(nameKey, { ns: `board-${board.id}` });
    },
    [board.id, board.tiles, t],
  );

  const proposerPlayer = players.find((player) => player.id === proposer);
  const recipientPlayer = recipient === null ? undefined : players.find((p) => p.id === recipient);
  const canSend = !draftEmpty && verdict !== null && verdict.legal && command !== null;

  return (
    <ModalDialog
      title={t("trade.title")}
      onClose={onClose}
      cannotCloseKey="trade.cannot_leave"
      headline={
        recipientPlayer === undefined
          ? undefined
          : t("trade.between", {
              proposer: playerName(proposer),
              recipient: recipientPlayer.name,
            })
      }
      footer={
        <>
          <Seal checking={checking} verdict={verdict} empty={draftEmpty} />
          {/* Hidden, not disabled, until the offer says something. An empty draft is legal and
              still not worth sending — the MON-410 amendment. */}
          {!draftEmpty && (
            <button
              type="button"
              disabled={!canSend}
              onClick={() => {
                if (command !== null) {
                  onSend(command);
                }
              }}
              className="target flex items-center gap-2 rounded-2xl border-2 border-hairline bg-ink px-5 text-lg font-bold text-tile disabled:opacity-40"
            >
              <Icon name="swap" size={20} />
              {t("trade.send")}
            </button>
          )}
        </>
      }
    >
      <fieldset className="border-0 p-0">
        <legend className="text-lg font-bold">{t("trade.recipient")}</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {others.map((player) => {
            const seat = seatOf(players, player.id);
            return (
              <label
                key={player.id}
                className="target flex items-center gap-2 rounded-2xl border-2 border-hairline px-3 font-semibold has-checked:bg-ink has-checked:text-tile"
              >
                <input
                  type="radio"
                  name="trade-recipient"
                  value={player.id}
                  checked={recipient === player.id}
                  onChange={() => {
                    setRecipient(player.id);
                    // The other side's things belong to whoever was on it. Carrying them over
                    // would offer away property the new recipient does not own.
                    setReceive(EMPTY_SIDE);
                  }}
                />
                {seat !== undefined && <Token seat={seat} size={TOKEN_PX.inline} />}
                {player.name}
              </label>
            );
          })}
        </div>
      </fieldset>

      {simplifiedTrades && (
        <p className="mt-3 rounded-2xl border-2 border-hairline p-3 text-sm font-medium">
          {t("trade.simplified_hint")}
        </p>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {proposerPlayer !== undefined && (
          <Tray
            owner={proposerPlayer}
            draft={give}
            onChange={setGive}
            tileName={tileName}
            renderDossier={renderDossier}
          />
        )}
        {recipientPlayer !== undefined && (
          <Tray
            owner={recipientPlayer}
            draft={receive}
            onChange={setReceive}
            tileName={tileName}
            renderDossier={renderDossier}
          />
        )}
      </div>
    </ModalDialog>
  );
}

/**
 * One side of the table.
 *
 * Everything offerable is listed and nothing is filtered: which of a player's properties may
 * actually change hands is a rule (a built colour group cannot be broken up), and this component
 * does not know it. The validator answers for the draft as a whole.
 */
/**
 * A pending offer, read-only, with the two answers to it (MON-422).
 *
 * Everything on screen is `frame.offer` — the engine's own record of what was proposed. Nothing is
 * recomputed and nothing is validated: the offer was already checked when it was proposed, and this
 * seat's only decision is yes or no. `respond_to_trade` carries that decision and nothing else, which
 * is why there is no draft state here at all.
 *
 * The two buttons are in the panel, not on the bar behind it. That was the defect: a modal showing an
 * offer with its answers somewhere else is a modal you have to dismiss to use.
 */
function TradeReview({
  frame,
  players,
  board,
  onSend,
  onClose,
  renderDossier,
}: {
  readonly frame: TradeFrameView;
  readonly players: readonly PlayerView[];
  readonly board: BoardView;
  readonly onSend: (command: Command) => void;
  readonly onClose?: (() => void) | undefined;
  readonly renderDossier?: ((playerId: number) => ReactNode) | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { offer } = frame;

  const playerName = useCallback(
    (playerId: number) =>
      players.find((player) => player.id === playerId)?.name ?? t("label.player"),
    [players, t],
  );
  const tileName = useCallback(
    (index: number) => {
      // Namespaced by board, the same lookup the draft trays make. A square's name lives in
      // `board-classic` / `board-israel`, not in `common`, so an unqualified `t(name_key)` resolves
      // against nothing — and a missing key *throws* in dev and test by design (G-F17), which is how
      // the first run of this component took the whole dialog down rather than showing a bad name.
      const nameKey = board.tiles.find((candidate) => candidate.index === index)?.name_key;
      return nameKey === undefined
        ? t("label.unknown_square")
        : t(nameKey, { ns: `board-${board.id}` });
    },
    [board, t],
  );

  /**
   * The answer, as a command.
   *
   * `player` is the offer's **recipient**, not the acting seat: the engine decides whose response is
   * legal (`error.not_trade_recipient`), and the one seat that can answer is named in the frame. This
   * panel reports that rather than guessing from whose turn it is — a trade review interrupts the
   * proposer's turn, so "current player" is the wrong answer here.
   */
  const respond = (accept: boolean): void => {
    onSend({ kind: "respond_to_trade", player: offer.recipient, accept });
  };

  return (
    <ModalDialog
      title={t("trade.review_title")}
      onClose={onClose}
      cannotCloseKey="trade.cannot_leave"
      headline={t("trade.between", {
        proposer: playerName(offer.proposer),
        recipient: playerName(offer.recipient),
      })}
      footer={
        <>
          <button
            type="button"
            data-testid="trade-decline"
            onClick={() => {
              respond(false);
            }}
            className="target border-hairline flex items-center gap-2 rounded-2xl border-2 px-5 text-lg font-bold"
          >
            <Icon name="cross" size={20} />
            {t("action.respond_to_trade_decline")}
          </button>
          <button
            type="button"
            data-testid="trade-accept"
            onClick={() => {
              respond(true);
            }}
            className="target border-hairline bg-ink text-tile flex items-center gap-2 rounded-2xl border-2 px-5 text-lg font-bold"
          >
            <Icon name="check" size={20} />
            {t("action.respond_to_trade_accept")}
          </button>
        </>
      }
    >
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        {/* `give` is what the proposer hands over, `receive` what they ask for — so the receive side
            is headed by the *recipient*, because those are the recipient's things. Getting these two
            the wrong way round would show a player the opposite of the deal. */}
        <OfferSide
          heading={t("trade.side_gives", { name: playerName(offer.proposer) })}
          side={offer.give}
          ownerId={offer.proposer}
          tileName={tileName}
          renderDossier={renderDossier}
        />
        <OfferSide
          heading={t("trade.side_gives", { name: playerName(offer.recipient) })}
          side={offer.receive}
          ownerId={offer.recipient}
          tileName={tileName}
          renderDossier={renderDossier}
        />
      </div>
    </ModalDialog>
  );
}

/** One half of a pending offer, as a list. No controls: this is a statement, not a form. */
function OfferSide({
  heading,
  side,
  ownerId,
  tileName,
  renderDossier,
}: {
  readonly heading: string;
  readonly side: TradeSide;
  readonly ownerId: number;
  readonly tileName: (index: number) => string;
  readonly renderDossier?: ((playerId: number) => ReactNode) | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  const empty = side.cash === 0 && side.tiles.length === 0 && side.jail_cards.length === 0;

  return (
    <section
      aria-label={heading}
      data-testid="offer-side"
      data-owner={ownerId}
      className="border-hairline rounded-2xl border-2 p-3"
    >
      <h3 className="text-base font-bold">{heading}</h3>

      {renderDossier !== undefined && <div className="mt-2">{renderDossier(ownerId)}</div>}

      {/* An empty side is a real offer — a gift, or a demand for nothing in return — so it says so
          rather than rendering three blank sections. */}
      {empty && <EmptyState messageKey="trade.side_empty" className="mt-3 font-medium" />}

      {side.cash > 0 && (
        <p className="mt-3 text-sm font-semibold">
          {t("trade.cash")}
          <span data-testid="offer-cash" dir="ltr" className="ms-2 tabular-nums">
            {side.cash}
          </span>
        </p>
      )}

      {side.tiles.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-semibold">{t("trade.properties")}</p>
          <ul className="mt-1 flex flex-col gap-1">
            {side.tiles.map((index) => (
              <li key={index} data-testid="offer-tile" data-tile={index} className="text-sm">
                {tileName(index)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {side.jail_cards.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-semibold">{t("trade.jail_cards")}</p>
          <ul className="mt-1 flex flex-col gap-1">
            {/* Deduplicated the way the draft trays are: two Chance cards are not two rows with the
                same name on them. */}
            {[...new Set(side.jail_cards)].map((deck) => (
              <li key={deck} data-testid="offer-jail-card" className="text-sm">
                {t(`deck.${deck}`)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Tray({
  owner,
  draft,
  onChange,
  tileName,
  renderDossier,
}: {
  readonly owner: PlayerView;
  readonly draft: SideDraft;
  readonly onChange: (next: SideDraft) => void;
  readonly tileName: (index: number) => string;
  readonly renderDossier?: ((playerId: number) => ReactNode) | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  // Deduplicated: the checkbox offers "a Chance card", and holding two of one pack is not a
  // second row with the same name on it.
  const decks = [...new Set(owner.jail_cards)];

  return (
    <section
      aria-label={t("trade.side_gives", { name: owner.name })}
      className="rounded-2xl border-2 border-hairline p-3"
    >
      <h3 className="text-base font-bold">{t("trade.side_gives", { name: owner.name })}</h3>

      {renderDossier !== undefined && <div className="mt-2">{renderDossier(owner.id)}</div>}

      <div className="mt-3">
        <p className="text-sm font-semibold">{t("trade.cash")}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={draft.cash === 0}
            onClick={() => {
              onChange({ ...draft, cash: Math.max(0, draft.cash - CASH_STEP) });
            }}
            className="target rounded-2xl border-2 border-hairline px-3 font-bold disabled:opacity-40"
          >
            <Icon name="minus" size={16} />
            <span className="sr-only">{t("trade.remove_cash", { amount: CASH_STEP })}</span>
          </button>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            dir="ltr"
            value={draft.cash}
            aria-label={t("trade.side_cash", { name: owner.name })}
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10);
              // Zero for junk, never a negative: a negative side is not an offer. Note what is
              // *not* here — no cap at `owner.cash`, because that is the engine's rule to state.
              onChange({ ...draft, cash: Number.isNaN(next) || next < 0 ? 0 : next });
            }}
            className="target w-24 rounded-2xl border-2 border-hairline bg-tile px-3 text-lg font-bold tabular-nums"
          />
          <button
            type="button"
            onClick={() => {
              onChange({ ...draft, cash: draft.cash + CASH_STEP });
            }}
            className="target rounded-2xl border-2 border-hairline px-3 font-bold"
          >
            <Icon name="plus" size={16} />
            <span className="sr-only">{t("trade.add_cash", { amount: CASH_STEP })}</span>
          </button>
        </div>
      </div>

      <fieldset className="mt-3 border-0 p-0">
        <legend className="text-sm font-semibold">{t("trade.properties")}</legend>
        {owner.tiles_owned.length === 0 ? (
          <EmptyState messageKey="trade.no_properties" className="mt-1" />
        ) : (
          <ul className="mt-1">
            {owner.tiles_owned.map((index) => (
              <li key={index}>
                <label className="target flex items-center gap-2 font-medium">
                  <input
                    type="checkbox"
                    checked={draft.tiles.includes(index)}
                    onChange={() => {
                      onChange({ ...draft, tiles: toggle(draft.tiles, index) });
                    }}
                  />
                  {tileName(index)}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <fieldset className="mt-3 border-0 p-0">
        <legend className="text-sm font-semibold">{t("trade.jail_cards")}</legend>
        {decks.length === 0 ? (
          <EmptyState messageKey="trade.no_jail_cards" className="mt-1" />
        ) : (
          <ul className="mt-1">
            {decks.map((deck) => (
              <li key={deck}>
                <label className="target flex items-center gap-2 font-medium">
                  <input
                    type="checkbox"
                    checked={draft.jailCards.includes(deck)}
                    onChange={() => {
                      onChange({ ...draft, jailCards: toggle(draft.jailCards, deck) });
                    }}
                  />
                  <Icon name="card" size={18} />
                  {t(`deck.${deck}`)}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
    </section>
  );
}

/**
 * The engine's verdict, stamped on the spine.
 *
 * `reason_key` is rendered with `params` and nothing is added to it: the sentence explaining why a
 * trade is refused is the engine's to write, in both languages, and a friendlier paraphrase here
 * would be a second wording to keep in step with the rules.
 */
function Seal({
  checking,
  verdict,
  empty,
}: {
  readonly checking: boolean;
  readonly verdict: LegalityView | null;
  readonly empty: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  if (empty) {
    return <EmptyState messageKey="trade.empty" className="grow font-medium opacity-100" />;
  }
  if (checking || verdict === null) {
    // `announce={false}`: the draft is re-validated on every change to it, so this state mounts
    // once per keystroke. See `LoadingState` for why a wait that repeats is not narrated.
    return (
      <LoadingState messageKey="trade.checking" announce={false} className="grow font-medium" />
    );
  }
  if (verdict.legal) {
    return (
      <p className="flex grow items-center gap-2 text-sm font-semibold">
        <Icon name="check" size={18} />
        {t("trade.ready")}
      </p>
    );
  }
  return (
    <p className="flex grow items-center gap-2 text-sm font-semibold">
      <Icon name="cross" size={18} />
      {verdict.reason_key === null || verdict.reason_key === undefined
        ? t("trade.refused")
        : t(verdict.reason_key, verdict.params)}
    </p>
  );
}
