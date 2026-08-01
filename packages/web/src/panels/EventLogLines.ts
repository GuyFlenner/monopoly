/**
 * One event in, one log line out. A pure table, no React, no i18next.
 *
 * The same shape of thing as `a11y/narration.ts`, and deliberately a *second* table rather
 * than a shared one: the narration says the two or three things a listener needs and stays
 * quiet about the rest, while the log is the written history and says all of it. Merging them
 * would force one of the two to compromise, and the compromise that loses is always the
 * screen-reader user's.
 *
 * Three properties this file exists to hold.
 *
 * 1. **No sentence is written here.** Every line is `{ key, params }`; the catalogue owns the
 *    prose, which is what makes the Hebrew build a catalogue rather than a diff (ADR-003).
 * 2. **No raw enum reaches a placeholder.** A `CashReason` interpolated straight into
 *    `{{reason}}` renders the English word `mortgage_transfer_fee` inside a Hebrew page — the
 *    exact GAP A5 defect. Every enum goes through a `*_LABEL` record below, whose type is
 *    `Record<TheEnum, string>` so a new member is a compile error rather than a silent leak.
 *
 *    The records that remain are all for enums the *event's own shape* carries. There used to be
 *    one more — `GROUP_KEYS`, mapping `ColorGroup` for the single `note_params` value that was an
 *    enum — and it is gone: the engine sends `group_key: "group.light_blue"` now, so nothing here
 *    knows what a colour group is (MON-415). See {@link resolveNoteParams}.
 * 3. **Every number comes off the event.** `RentCharged` carries `amount`, `base_rent`,
 *    `houses`, `multiplier`, `dice_total` and its own `note_keys`/`note_params` precisely so a
 *    turn-3 line does not render turn-20 state (G-36). Nothing here reads current state, and
 *    if a sentence needs a figure no event carries, that is a contract gap to file rather than
 *    an expression to write here.
 */

import type { EventOfType, GameEvent, GameEventType, LoggedEvent } from "@/api";

/** A translated-string or numeric parameter. Never an enum value — see the header. */
export type LineParams = Readonly<Record<string, string | number>>;

/**
 * How a log line prints, before i18next sees it.
 *
 * `count` is separate from `params` because it is the one parameter i18next treats as
 * grammar rather than data: it selects the plural form. Keeping it out of `params` means a
 * line that does not pluralize cannot accidentally acquire a plural suffix.
 */
export interface LogLine {
  /** A catalogue key, always. `log.<something>`, matching the engine's `type` where it can. */
  readonly key: string;
  readonly params: LineParams;
  /** Present only where the sentence pluralizes. */
  readonly count?: number;
  /** A decorative glyph, `aria-hidden` at the call site: the sentence carries the meaning. */
  readonly icon: string;
  /**
   * `turn` marks a boundary in a real sequence and is drawn as a rule across the list;
   * `entry` is an ordinary row. Not a style name — a statement about the content.
   */
  readonly shape: "entry" | "turn";
  /**
   * Extra `rent.note.*` explanations the engine attached, already resolved to keys and
   * params. Empty for everything except rent, and the reason `rent.note.*` keys exist at all
   * (spec §5.5: every rent figure can be *explained*, not merely charged).
   */
  readonly notes: readonly LogLine[];
}

/**
 * What the log needs to look up, and the only two things it may.
 *
 * Both are lookups into data the server already sent — a seat's name out of `state.players`,
 * a tile's name key out of `board.tiles`. Neither derives anything.
 */
export interface LineContext {
  readonly playerName: (playerId: number) => string;
  readonly tileName: (tileIndex: number) => string;
  /**
   * Translate a catalogue key. Handed in rather than imported so this file stays pure and a
   * test can assert on keys instead of on English.
   */
  readonly translate: (key: string, params?: LineParams) => string;
}

// --- Enum labels ------------------------------------------------------------
// Each of these is `Record<TheEnum, key>`: removing a member breaks the build, adding one
// breaks the build, and no code path can reach an unlabelled value. That is the structural
// version of "never render a raw enum".

type CashReason = EventOfType<"cash_changed">["reason"];
type AcquiredVia = EventOfType<"property_acquired">["via"];
type AuctionReason = EventOfType<"auction_started">["reason"];
type Deck = EventOfType<"card_drawn">["deck"];
type JailedVia = EventOfType<"sent_to_jail">["via"];
type ReleasedVia = EventOfType<"left_jail">["via"];
type DicePurpose = EventOfType<"dice_rolled">["purpose"];
type EndReason = EventOfType<"game_ended">["reason"];
type Building = Extract<EventOfType<"auction_started">["lot"], { kind: "building" }>["building"];
type Creditor = EventOfType<"debt_incurred">["creditor"];

export const CASH_REASON_KEYS: Readonly<Record<CashReason, string>> = {
  go_salary: "cash_reason.go_salary",
  rent: "cash_reason.rent",
  purchase: "cash_reason.purchase",
  auction_win: "cash_reason.auction_win",
  tax: "cash_reason.tax",
  jail_fine: "cash_reason.jail_fine",
  card: "cash_reason.card",
  build: "cash_reason.build",
  sell_building: "cash_reason.sell_building",
  mortgage: "cash_reason.mortgage",
  unmortgage: "cash_reason.unmortgage",
  mortgage_transfer_fee: "cash_reason.mortgage_transfer_fee",
  trade: "cash_reason.trade",
  bankruptcy_transfer: "cash_reason.bankruptcy_transfer",
  free_parking_pot: "cash_reason.free_parking_pot",
};

const ACQUIRED_KEYS: Readonly<Record<AcquiredVia, string>> = {
  purchase: "log.property_acquired_purchase",
  auction: "log.property_acquired_auction",
  trade: "log.property_acquired_trade",
  bankruptcy: "log.property_acquired_bankruptcy",
};

export const AUCTION_REASON_KEYS: Readonly<Record<AuctionReason, string>> = {
  declined_purchase: "auction_reason.declined_purchase",
  bankruptcy_to_bank: "auction_reason.bankruptcy_to_bank",
  building_shortage: "auction_reason.building_shortage",
};

export const DECK_KEYS: Readonly<Record<Deck, string>> = {
  chance: "deck.chance",
  community_chest: "deck.community_chest",
};

const JAILED_KEYS: Readonly<Record<JailedVia, string>> = {
  tile: "log.sent_to_jail_tile",
  card: "log.sent_to_jail_card",
  three_doubles: "log.sent_to_jail_three_doubles",
};

const RELEASED_KEYS: Readonly<Record<ReleasedVia, string>> = {
  fine: "log.left_jail_fine",
  card: "log.left_jail_card",
  doubles: "log.left_jail_doubles",
  time_served: "log.left_jail_time_served",
};

const DICE_PURPOSE_KEYS: Readonly<Record<DicePurpose, string>> = {
  move: "log.dice_rolled_move",
  jail: "log.dice_rolled_jail",
  rent: "log.dice_rolled_rent",
};

export const END_REASON_KEYS: Readonly<Record<EndReason, string>> = {
  last_solvent: "game_end_reason.last_solvent",
  time_limit: "game_end_reason.time_limit",
  concession: "game_end_reason.concession",
  no_survivors: "game_end_reason.no_survivors",
};

export const BUILDING_KEYS: Readonly<Record<Building, string>> = {
  house: "building.house",
  hotel: "building.hotel",
};

/** The suffix marking a `note_params` entry as a catalogue key rather than a value. */
const KEY_SUFFIX = "_key";

/**
 * Resolve the `*_key` entries in a rent note's params, and drop the raw keys.
 *
 * The engine's convention (see `RentQuote.note_params`): a param named `<name>_key` carries an
 * i18n key, so `{group_key: "group.light_blue"}` becomes `{group: "Light blue"}` and the catalogue
 * sentence keeps its natural `{{group}}` in both languages.
 *
 * This replaced `GROUP_KEYS` and its `isColorGroup` guard, and the difference is not cosmetic.
 * That version had to know the eight `ColorGroup` members and had to recognise one of them by
 * value — a raw engine enum translated at the render boundary, which is the MON-415 gap. This
 * knows only that a name ending in `_key` names a key, so the next engine note to interpolate a
 * key needs no change here at all. A value the catalogue cannot resolve is left as it arrived
 * rather than blanked: `missingKeyHandler` throws under dev and test by design (G-F17), and one
 * unresolvable note must not take the whole log down.
 *
 * Exported because the "explain this rent" affordance renders the same notes from a `RentQuote`
 * (MON-420) and must resolve them the same way — two resolvers is how the log and the board would
 * end up explaining one figure differently.
 */
export function resolveNoteParams(
  raw: Readonly<Record<string, string | number>> | undefined,
  context: Pick<LineContext, "translate">,
): LineParams {
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (name.endsWith(KEY_SUFFIX) && typeof value === "string") {
      params[name.slice(0, -KEY_SUFFIX.length)] = context.translate(value);
    } else {
      params[name] = value;
    }
  }
  return params;
}

/**
 * Event types the log deliberately does not write down, and why.
 *
 * `phase_changed` is the machine's own bookkeeping: it fires on every transition, so a line
 * per change would treble the log's length while adding nothing a player could not see from
 * the screen — and the three transitions that *are* worth knowing about (auction, debt, trade
 * review) are the ones the `<Announcer>` speaks assertively (MON-411). Silence here is a
 * choice, and `SILENT_EVENTS` plus the exhaustive table below is what keeps it a choice: a
 * new event type cannot become invisible without failing the build.
 */
export const SILENT_EVENTS = new Set<GameEventType>(["phase_changed"]);

/** A decorative glyph per event type, one channel that is not text (spec §5.5, G-50). */
const ICONS: Readonly<Record<GameEventType, string>> = {
  turn_started: "▶",
  dice_rolled: "🎲",
  token_moved: "👣",
  cash_changed: "💰",
  rent_charged: "🏠",
  property_acquired: "🔑",
  auction_started: "🔔",
  bid_placed: "✋",
  bidder_withdrew: "🚪",
  auction_ended: "🔨",
  card_drawn: "🃏",
  sent_to_jail: "🔒",
  left_jail: "🔓",
  building_changed: "🧱",
  mortgage_changed: "📄",
  trade_proposed: "🤝",
  trade_executed: "🤝",
  trade_declined: "🙅",
  trade_cancelled: "↩",
  debt_incurred: "⚠",
  debt_settled: "✅",
  player_bankrupted: "💀",
  phase_changed: "•",
  game_ended: "🏆",
};

// --- The table --------------------------------------------------------------

/**
 * `null` where {@link SILENT_EVENTS} says so, a factory everywhere else.
 *
 * `Record<GameEventType, …>` is doing real work: `GameEventType` is read off the generated
 * types, so an event the engine adds is a compile error here rather than a blank row.
 */
type LineFactory<T extends GameEventType> = (
  event: EventOfType<T>,
  context: LineContext,
) => Omit<LogLine, "icon" | "notes"> & { readonly notes?: readonly LogLine[] };

type LineTable = { readonly [T in GameEventType]: LineFactory<T> | null };

const TABLE: LineTable = {
  turn_started: (event, context) => ({
    key: "log.turn_started",
    shape: "turn",
    params: { turn: event.turn_number, name: context.playerName(event.player) },
  }),

  dice_rolled: (event, context) => ({
    key: DICE_PURPOSE_KEYS[event.purpose],
    shape: "entry",
    params: {
      name: context.playerName(event.player),
      first: event.first,
      second: event.second,
      total: event.total,
    },
  }),

  token_moved: (event, context) => ({
    // Three sentences rather than one with a conditional clause: "moved backwards" and
    // "passing GO" are different facts, and a language that puts the adverb elsewhere needs
    // to be able to rewrite the whole sentence.
    key: !event.forward
      ? "log.token_moved_back"
      : event.passed_go
        ? "log.token_moved_passed_go"
        : "log.token_moved",
    shape: "entry",
    params: { name: context.playerName(event.player), tile: context.tileName(event.to_tile) },
  }),

  cash_changed: (event, context) => ({
    // The sign selects the verb. Grammar, not arithmetic: both the delta and the balance are
    // the server's, and nothing here works out what either should have been.
    key: event.delta > 0 ? "log.cash_gained" : "log.cash_paid",
    shape: "entry",
    params: {
      name: context.playerName(event.player),
      amount: Math.abs(event.delta),
      reason: context.translate(CASH_REASON_KEYS[event.reason]),
    },
  }),

  rent_charged: (event, context) => ({
    key: "log.rent_charged",
    shape: "entry",
    params: {
      payer: context.playerName(event.payer),
      owner: context.playerName(event.owner),
      amount: event.amount,
      tile: context.tileName(event.tile),
    },
    notes: rentNotes(event, context),
  }),

  property_acquired: (event, context) => ({
    key: ACQUIRED_KEYS[event.via],
    shape: "entry",
    params: {
      name: context.playerName(event.player),
      tile: context.tileName(event.tile),
      price: event.price,
    },
  }),

  auction_started: (event, context) => ({
    key: "log.auction_started",
    shape: "entry",
    params: {
      lot: lotLabel(event.lot, context),
      reason: context.translate(AUCTION_REASON_KEYS[event.reason]),
    },
  }),

  bid_placed: (event, context) => ({
    key: "log.bid_placed",
    shape: "entry",
    params: { name: context.playerName(event.player), amount: event.amount },
  }),

  bidder_withdrew: (event, context) => ({
    key: "log.bidder_withdrew",
    shape: "entry",
    params: { name: context.playerName(event.player) },
  }),

  auction_ended: (event, context) => {
    const lot = lotLabel(event.lot, context);
    // `winner` is nullable because an auction can genuinely end with nobody bidding, and
    // "undefined won it for 0" is the line a truthy check would print.
    return event.winner === null || event.winner === undefined
      ? { key: "log.auction_ended_unsold", shape: "entry", params: { lot } }
      : {
          key: "log.auction_ended",
          shape: "entry",
          params: { name: context.playerName(event.winner), lot, price: event.price },
        };
  },

  card_drawn: (event, context) => ({
    // The card's own text is in the `cards` namespace, which `i18n/index.ts` does not
    // register — see the report; naming the deck is everything this line can honestly say.
    key: "log.card_drawn",
    shape: "entry",
    params: {
      name: context.playerName(event.player),
      deck: context.translate(DECK_KEYS[event.deck]),
    },
  }),

  sent_to_jail: (event, context) => ({
    key: JAILED_KEYS[event.via],
    shape: "entry",
    params: { name: context.playerName(event.player) },
  }),

  left_jail: (event, context) => ({
    key: RELEASED_KEYS[event.via],
    shape: "entry",
    params: { name: context.playerName(event.player) },
  }),

  building_changed: (event, context) => ({
    // MON-413: `level` says which building moved, so the sentence says "hotel" or "house".
    //
    // It used to say "a building went up" for both, because the event carried only `houses` and
    // `delta` and inferring "five houses means a hotel" here would have been the engine's rule
    // living in the UI. `level` is now the engine's answer, and this is a lookup on it.
    //
    // A hotel is always exactly one, so its two keys do not pluralize; a house sale can take
    // several off a group at once, so those do. `houses` is the count *after* the change and
    // `delta` is the change — both still straight off the wire.
    key: `log.${event.level}_${event.delta > 0 ? "built" : "sold"}`,
    shape: "entry",
    ...(event.level === "house" ? { count: Math.abs(event.delta) } : {}),
    params: { tile: context.tileName(event.tile), remaining: event.houses },
  }),

  mortgage_changed: (event, context) => ({
    // MON-414: the event names the player, so the line has a subject.
    //
    // The passive voice ("Boardwalk was mortgaged") was the honest rendering while the event
    // carried only the tile and the flag. Mortgaging is legal off-turn, so reading the actor from
    // `state.current_player_id` would have been wrong exactly when it mattered — and reading
    // current state at all breaks the log's self-containment rule (ADR-008 §3).
    key: event.mortgaged ? "log.mortgaged" : "log.unmortgaged",
    shape: "entry",
    params: { name: context.playerName(event.player), tile: context.tileName(event.tile) },
  }),

  trade_proposed: (event, context) => ({
    key: "log.trade_proposed",
    shape: "entry",
    params: tradeParties(event.offer, context),
  }),

  trade_executed: (event, context) => ({
    key: "log.trade_executed",
    shape: "entry",
    params: tradeParties(event.offer, context),
  }),

  trade_declined: (event, context) => ({
    key: "log.trade_declined",
    shape: "entry",
    params: tradeParties(event.offer, context),
  }),

  trade_cancelled: (event, context) => ({
    key: event.by === "proposer" ? "log.trade_cancelled_proposer" : "log.trade_cancelled_system",
    shape: "entry",
    params: tradeParties(event.offer, context),
  }),

  debt_incurred: (event, context) => ({
    key: "log.debt_incurred",
    shape: "entry",
    params: {
      debtor: context.playerName(event.debtor),
      creditor: creditorName(event.creditor, context),
      amount: event.amount,
    },
  }),

  debt_settled: (event, context) => ({
    key: "log.debt_settled",
    shape: "entry",
    params: {
      debtor: context.playerName(event.debtor),
      creditor: creditorName(event.creditor, context),
      amount: event.amount,
    },
  }),

  player_bankrupted: (event, context) => ({
    key: "log.player_bankrupted",
    shape: "entry",
    params: {
      name: context.playerName(event.player),
      creditor: creditorName(event.creditor, context),
    },
  }),

  phase_changed: null,

  game_ended: (event, context) => {
    const reason = context.translate(END_REASON_KEYS[event.reason]);
    return event.winner === null || event.winner === undefined
      ? { key: "log.game_ended_no_winner", shape: "entry", params: { reason } }
      : {
          key: "log.game_ended",
          shape: "entry",
          params: { name: context.playerName(event.winner), reason },
        };
  },
};

/**
 * The line for one event, or `null` where the log stays quiet.
 *
 * The cast is the price of a discriminated-union lookup table in TypeScript: `TABLE[type]` is
 * the union of every factory, and TS cannot see that the entry it just indexed by `event.type`
 * takes exactly this event. The type safety that matters — every event type has an entry, and
 * every entry takes the matching event — is enforced where the table is declared.
 */
export function lineFor(event: GameEvent, context: LineContext): LogLine | null {
  const factory = TABLE[event.type] as LineFactory<GameEventType> | null;
  if (factory === null) {
    return null;
  }
  const line = factory(event, context);
  return { notes: [], ...line, icon: ICONS[event.type] };
}

/** Newest first, silent events dropped, at most `limit` rows. */
export function linesFor(
  events: readonly LoggedEvent[],
  context: LineContext,
  limit: number,
): readonly { readonly seq: number; readonly line: LogLine }[] {
  const rows: { seq: number; line: LogLine }[] = [];
  // Walked backwards so the cap keeps the newest `limit` rows rather than the oldest, and
  // without copying and reversing a log that can be thousands of frames long.
  for (let index = events.length - 1; index >= 0 && rows.length < limit; index -= 1) {
    const frame = events[index];
    if (frame === undefined) {
      continue;
    }
    const line = lineFor(frame.event, context);
    if (line !== null) {
      rows.push({ seq: frame.seq, line });
    }
  }
  return rows;
}

// --- Helpers ----------------------------------------------------------------

function tradeParties(
  offer: EventOfType<"trade_proposed">["offer"],
  context: LineContext,
): LineParams {
  return {
    proposer: context.playerName(offer.proposer),
    recipient: context.playerName(offer.recipient),
  };
}

/** `bank` is a named creditor on the wire, not a `null` sentinel — so it gets a real label. */
function creditorName(creditor: Creditor, context: LineContext): string {
  return creditor === "bank" ? context.translate("label.bank") : context.playerName(creditor);
}

function lotLabel(event: EventOfType<"auction_started">["lot"], context: LineContext): string {
  return event.kind === "tile"
    ? context.tileName(event.tile)
    : context.translate(BUILDING_KEYS[event.building]);
}

/**
 * The engine's own explanations, rendered as sub-lines rather than restated.
 *
 * `note_keys` and `note_params` come off the event, so the explanation of a turn-3 rent is still
 * the turn-3 explanation when read on turn 20. The only transformation is
 * {@link resolveNoteParams}, and it is generic — nothing here decides what any particular note
 * means.
 */
function rentNotes(event: EventOfType<"rent_charged">, context: LineContext): readonly LogLine[] {
  return noteLines(event.note_keys, event.note_params, context);
}

/**
 * `rent.note.*` keys as renderable sub-lines. Shared with the rent-quote affordance (MON-420).
 */
export function noteLines(
  noteKeys: readonly string[],
  noteParams: Readonly<Record<string, string | number>> | undefined,
  context: Pick<LineContext, "translate">,
): readonly LogLine[] {
  const params = resolveNoteParams(noteParams, context);
  return noteKeys.map((key) => ({
    key,
    params,
    icon: "→",
    shape: "entry" as const,
    notes: [],
  }));
}
