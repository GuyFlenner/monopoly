"""Debts, bankruptcy, and the chains a bankruptcy sets off (MON-207).

The model is shortfall-as-data (GAP G-18): cash never goes negative — what cannot be
paid becomes a :class:`~kesef_engine.state.DebtFrame`, and settlement happens *the moment
the debtor's cash covers the total*, automatically, after every command. There is no
PayDebt command: raising the money is the player's move; paying it is not optional. The
debtor's other move is to concede — ``DeclareBankruptcy`` is legal throughout
``DEBT_SETTLEMENT``, including while the estate could still raise the debt.

Four rules here are house conventions the printed rulebook leaves open, and GAP §7 gave
each an owner. They are stated once, here, because every one of them is a place where a
plausible guess is wrong:

**Settlement order.** A debt with several creditors ("pay each player ₪50" is one debt with
N obligations, G-7) pays them **clockwise from the debtor**, not in the order the frame
happened to record. Settlement stays all-or-nothing: paying the near creditors first and
leaving the far ones to the estate would quietly contradict the proportional division
below, so the debt sits open until the whole total is in hand.

**Proportional division.** On bankruptcy with several creditors the estate divides
**proportionally to claim** (G-7). Cash divides exactly — floor shares, then the remaining
units one at a time to the largest claims. Property and jail cards cannot be cut, so each
goes to whichever creditor is furthest below their proportional entitlement, which is the
same rule generalised to indivisible lots.

**The mortgage transfer fee.** The receiver of a mortgaged property pays the bank 10% of
the mortgage value at transfer (owner decision 2, the full official rule, G-13). It is
charged the moment the estate changes hands and it can exceed the receiver's cash — which
is precisely how a bankruptcy cascades onto the *creditor*, and why ``GameEnded.winner``
is optional. The fee is per-tile arithmetic summed into one payment per receiver, because
the ledger has no finer unit than a payment.

**Where the property goes.** A single creditor takes the estate whole. Several creditors
divide it. Only when no *player* is owed anything does property go to the bank, as a
**queued multi-lot auction** (``AuctionFrame.queue``, clockwise from the debtor's left,
G-15) — the bank has no use for a deed except to put it back in play, and if a player
creditor is standing there it is already back in play. That also keeps a bank auction and
a player transfer mutually exclusive, so no fee debt can ever open on a bidder in a live
auction.

Endgame is deliberately *not* decided here. :func:`close_command` evaluates it once per
command — and only after the interrupt stack has drained (G-8), which is what stops a
two-player bankruptcy to the bank from freezing on an auction nobody may bid in.
"""

from __future__ import annotations

from kesef_engine.commands import DeclareBankruptcy
from kesef_engine.decks import GET_OUT_OF_JAIL_IDS
from kesef_engine.events import (
    BankruptcyShare,
    BuildingChanged,
    Creditor,
    DebtIncurred,
    DebtSettled,
    Event,
    PlayerBankrupted,
    TradeCancelled,
)
from kesef_engine.phases import Phase
from kesef_engine.primitives import AuctionReason, CashReason, Deck, Lot, PlayerId, TileIndex, TileLot
from kesef_engine.rules import auction, endgame, mortgage, turns
from kesef_engine.rules.cash import move_cash
from kesef_engine.rules.common import update_player, update_property
from kesef_engine.state import (
    PHASE_OF_FRAME,
    AuctionFrame,
    DebtFrame,
    GameState,
    InterruptFrame,
    Obligation,
    TradeFrame,
)

# The transfer fee lives in one place only. MON-204 (trade) and MON-207 (bankruptcy) charge
# the identical fee on the identical event — a mortgaged deed changing hands — and two
# implementations of one rule is the drift the M1 review caught in the building stock.
mortgage_transfer_fee = mortgage.transfer_fee


def open_debt(
    state: GameState,
    *,
    debtor: PlayerId,
    creditor: Creditor,
    amount: int,
    reason: CashReason,
    source_tile: TileIndex | None = None,
    resume: Phase,
) -> tuple[GameState, tuple[Event, ...]]:
    """Suspend play into DEBT_SETTLEMENT. ``resume`` is where play continues once paid."""
    obligation = Obligation(creditor=creditor, amount=amount)
    frame = DebtFrame(resume=resume, debtor=debtor, obligations=(obligation,), reason=reason, source_tile=source_tile)
    state = state._replace(phase=resume).push_interrupt(frame)
    return state, (DebtIncurred(debtor=debtor, creditor=obligation.creditor, amount=amount),)


def close_command(state: GameState) -> tuple[GameState, tuple[Event, ...]]:
    """Close the command: endgame, then the seat hand-off. Called once per ``apply``.

    Only when the interrupt stack is *empty* may endgame look — a live estate auction has to
    finish first (G-8), or a two-player bankruptcy to the bank freezes with no legal command.
    Last, a seat still held by a player who has just gone under is handed on, which is what
    keeps "the current player is bankrupt" from becoming a deadlock (G-14).

    Read the early return carefully, because it is load-bearing and it was mis-stated
    elsewhere for a while: while the stack is non-empty the hand-off is skipped **too**. So a
    bankruptcy to the bank really does come to rest with a bankrupt current player, for as
    long as the estate auction it opened runs. That state is legal and it is not a deadlock —
    every other seat is still offered the auction's commands — which is why the structural
    generator draws a bankrupt current player on purpose rather than narrowing it away.

    The settle cascade this function used to run first now lives in the reducer's fixpoint
    loop (:func:`kesef_engine.reducer._drain`): settling can re-expose a *card* frame that a
    debt had suspended, and settling here — after the reducer's card loop had already
    finished — left ``apply`` resting in a transient phase and tripped its own contract
    assertion instead of resuming the card.
    """
    if state.interrupts:
        return state, ()
    state, events = endgame.maybe_end(state)
    if state.phase is not Phase.GAME_OVER and state.current_player.bankrupt:
        state, started = turns.advance_turn(state)
        events = (*events, *started)
    return state, events


def settle_if_able(state: GameState) -> tuple[GameState, tuple[Event, ...]]:
    """Pay the live debt in full the moment the debtor's cash covers it.

    Runs after every command, so a mortgage, a sale or an accepted trade settles the debt
    without a further command. All-or-nothing, and clockwise from the debtor when there is
    more than one creditor — see the module docstring for why partial settlement is not the
    same rule wearing a different hat.
    """
    frame = state.top_interrupt
    if state.phase is not Phase.DEBT_SETTLEMENT or not isinstance(frame, DebtFrame):
        return state, ()
    if state.player(frame.debtor).cash < frame.total:
        return state, ()
    state = state.pop_interrupt()
    events: list[Event] = []
    for obligation in _in_turn_order(state, frame.debtor, frame.obligations):
        state, paid = move_cash(
            state, source=frame.debtor, dest=obligation.creditor, amount=obligation.amount, reason=frame.reason
        )
        events.extend(paid)
        events.append(DebtSettled(debtor=frame.debtor, creditor=obligation.creditor, amount=obligation.amount))
    if frame.reason is CashReason.JAIL_FINE and state.player(frame.debtor).in_jail:
        # Only the *compulsory* fine can become a debt (the voluntary one is gated on cash
        # by legality), so this is always the after-``max_jail_turns`` path — and the
        # official rule then walks the total of the roll that failed. Imported locally
        # because jail depends on ``open_debt`` here: the cycle is real, and one function
        # call is a smaller price than a module whose only job is to break it.
        from kesef_engine.rules import jail

        state, released = jail.release_after_compulsory_fine(state, frame.debtor)
        events.extend(released)
    return state, tuple(events)


def handle_declare_bankruptcy(state: GameState, command: DeclareBankruptcy) -> tuple[GameState, tuple[Event, ...]]:
    """The debtor concedes and leaves the game, estate and all.

    The sequence matters and is therefore numbered: buildings must be back with the bank
    before the estate is valued, the frame must be off the stack before anything is paid
    out of it, and the debtor must be *marked* bankrupt before the bidding order for their
    own estate auction is taken.
    """
    frame = state.top_interrupt
    assert isinstance(frame, DebtFrame)  # is_legal proved it
    debtor_id = frame.debtor
    events: list[Event] = []

    # 1. Buildings are sold to the bank at half price; the houses themselves rejoin the
    #    bank's finite stock (derived from the board, so clearing the tile is enough).
    state, liquidated = _liquidate_buildings(state, debtor_id)
    events.extend(liquidated)

    # 2. The debt is over — it is being paid in kind — and every other claim the leaving
    #    player is a party to falls away with them.
    state = state.pop_interrupt()
    state, voided = _void_claims_of(state, debtor_id)
    events.extend(voided)

    # 3. The estate is valued and divided before a single asset moves, so that the division
    #    is a function of one consistent state rather than of its own progress.
    debtor = state.player(debtor_id)
    estate_tiles = state.tiles_owned_by(debtor_id)
    estate_cash = debtor.cash
    estate_cards = debtor.jail_cards
    shares = _divide_estate(state, debtor_id, frame.obligations, estate_cash, estate_tiles, estate_cards)

    # 4. Cash, through the ledger — the only writer of a player's balance (G-60).
    for share in shares:
        state, paid = move_cash(
            state, source=debtor_id, dest=share.creditor, amount=share.cash, reason=CashReason.BANKRUPTCY_TRANSFER
        )
        events.extend(paid)

    # 5. Jail cards. The debtor's hand empties first: two players may not hold one deck's
    #    card at the same time, and the state model enforces that mid-transfer as well.
    state = update_player(state, debtor_id, jail_cards=())
    for share in shares:
        if not share.jail_cards:
            continue
        if share.creditor == "bank":
            state = _return_jail_cards(state, share.jail_cards)
        else:
            held = state.player(share.creditor).jail_cards
            state = update_player(state, share.creditor, jail_cards=(*held, *share.jail_cards))

    # 6. Deeds. A player creditor takes them as they stand, mortgage and all; the bank's
    #    become auction lots, and an unowned tile cannot carry a mortgage.
    bank_lots: list[Lot] = []
    for share in shares:
        for tile_index in share.tiles:
            if share.creditor == "bank":
                state = update_property(state, tile_index, owner=None, mortgaged=False)
                bank_lots.append(TileLot(tile=tile_index))
            else:
                state = update_property(state, tile_index, owner=share.creditor)

    # 7. The debtor leaves the game holding nothing (state invariant: bankrupt => free).
    #    Cash is *not* zeroed here: the whole balance already moved through move_cash.
    state = update_player(state, debtor_id, bankrupt=True, in_jail=False, jail_turns=0, jail_cards=())
    state = state._replace(elimination_order=(*state.elimination_order, debtor_id))
    events.append(
        PlayerBankrupted(
            player=debtor_id,
            creditor=_principal_creditor(shares),
            tiles_transferred=estate_tiles,
            cash_transferred=estate_cash,
            jail_cards_transferred=estate_cards,
            shares=shares if len(shares) > 1 else (),
        )
    )

    # 8. What the transfer itself set off. The estate auction goes on the stack first so
    #    that a fee debt — which its receiver must answer *now* — sits above it.
    if bank_lots:
        state, opened = auction.open_auction(
            state,
            lots=tuple(bank_lots),
            reason=AuctionReason.BANKRUPTCY_TO_BANK,
            eligible=auction.bidding_order(state, start_from=debtor_id, include_start=False),
        )
        events.extend(opened)
    state, fees = _charge_mortgage_transfer_fees(state, shares)
    events.extend(fees)
    return state, tuple(events)


# --- Estate division --------------------------------------------------------


def _divide_estate(
    state: GameState,
    debtor: PlayerId,
    obligations: tuple[Obligation, ...],
    cash: int,
    tiles: tuple[TileIndex, ...],
    cards: tuple[Deck, ...],
) -> tuple[BankruptcyShare, ...]:
    """Who gets what, proportionally to claim (G-7). Turn order from the debtor throughout.

    Returns one share per *creditor* — obligations naming the same creditor twice are one
    claim — in settlement order, so the ledger entries come out in the order the debt would
    have been paid in had it been paid in money.
    """
    claims = _claims_in_turn_order(state, debtor, obligations)
    cash_shares = _divide_cash(state, debtor, claims, cash)
    # Only a player can be *given* a deed; the bank merely re-sells it. So indivisible
    # assets divide among the player creditors, and fall to the bank only when there are
    # none — which is also the ordinary bankruptcy-to-the-bank path, unspecialised.
    recipients = [claim for claim in claims if claim[0] != "bank"] or [("bank", sum(a for _, a in claims))]
    assets: list[tuple[TileIndex | Deck, int]] = [(tile, _tile_value(state, tile)) for tile in tiles]
    assets += [(card, state.ruleset.jail_fine) for card in cards]
    allotted = _allot_indivisible(state, debtor, recipients, assets)
    return tuple(
        BankruptcyShare(
            creditor=creditor,
            claim=amount,
            cash=cash_shares[creditor],
            # ``.get``: a bank claim standing alongside a player's takes its share in cash
            # only, so it is not among the recipients of the indivisible assets at all.
            tiles=tuple(asset for asset in allotted.get(creditor, ()) if not isinstance(asset, Deck)),
            jail_cards=tuple(asset for asset in allotted.get(creditor, ()) if isinstance(asset, Deck)),
        )
        for creditor, amount in claims
    )


def _divide_cash(
    state: GameState, debtor: PlayerId, claims: list[tuple[Creditor, int]], cash: int
) -> dict[Creditor, int]:
    """Floor shares, then the rounding units to the largest claims — exact, and every
    shekel of the estate accounted for."""
    total = sum(amount for _, amount in claims)
    shares = {creditor: cash * amount // total for creditor, amount in claims}
    remainder = cash - sum(shares.values())
    for creditor, _ in _by_precedence(state, debtor, claims)[:remainder]:
        shares[creditor] += 1
    return shares


def _allot_indivisible(
    state: GameState,
    debtor: PlayerId,
    recipients: list[tuple[Creditor, int]],
    assets: list[tuple[TileIndex | Deck, int]],
) -> dict[Creditor, list[TileIndex | Deck]]:
    """Deal deeds and jail cards to whoever is furthest below their proportional entitlement.

    The comparison is integer arithmetic on purpose: ``value * claim`` against
    ``received * total_claims`` orders the entitlement gaps without ever building a
    fraction, so the division is exact and identical on every machine.
    """
    total_claims = sum(amount for _, amount in recipients)
    total_value = sum(value for _, value in assets)
    order = _by_precedence(state, debtor, recipients)
    allotted: dict[Creditor, list[TileIndex | Deck]] = {creditor: [] for creditor, _ in recipients}
    received: dict[Creditor, int] = dict.fromkeys(allotted, 0)
    for asset, value in assets:
        # ``max`` keeps the first maximum, so ``order`` is the tie-break: largest claim
        # first, then clockwise from the debtor.
        taker = max(order, key=lambda claim: total_value * claim[1] - received[claim[0]] * total_claims)[0]
        allotted[taker].append(asset)
        received[taker] += value
    return allotted


def _tile_value(state: GameState, tile: TileIndex) -> int:
    """What a deed is worth to a creditor: its printed price, less the mortgage still on it.

    Only ever an *allotment* yardstick — rent, net worth and an auction each price a tile
    their own way, and a share of an estate is a fourth question.
    """
    board_tile = state.board.tile(tile)
    value = board_tile.price or 0
    if state.properties[tile].mortgaged:
        value -= board_tile.mortgage or 0
    return max(value, 0)


def _claims_in_turn_order(
    state: GameState, debtor: PlayerId, obligations: tuple[Obligation, ...]
) -> list[tuple[Creditor, int]]:
    """One entry per creditor, amounts summed, clockwise from the debtor."""
    totals: dict[Creditor, int] = {}
    for obligation in _in_turn_order(state, debtor, obligations):
        totals[obligation.creditor] = totals.get(obligation.creditor, 0) + obligation.amount
    return list(totals.items())


def _by_precedence(
    state: GameState, debtor: PlayerId, claims: list[tuple[Creditor, int]]
) -> list[tuple[Creditor, int]]:
    """Largest claim first, ties broken clockwise from the debtor. The rounding order."""
    rank = _creditor_rank(state, debtor)
    return sorted(claims, key=lambda claim: (-claim[1], rank[claim[0]]))


def _in_turn_order(state: GameState, debtor: PlayerId, obligations: tuple[Obligation, ...]) -> tuple[Obligation, ...]:
    rank = _creditor_rank(state, debtor)
    return tuple(sorted(obligations, key=lambda obligation: rank[obligation.creditor]))


def _creditor_rank(state: GameState, debtor: PlayerId) -> dict[Creditor, int]:
    """Seats clockwise from the debtor's left. The bank holds no seat, so it sorts last."""
    seat_count = len(state.players)
    start = next(index for index, player in enumerate(state.players) if player.id == debtor)
    ranks: dict[Creditor, int] = {
        state.players[(start + offset) % seat_count].id: offset - 1 for offset in range(1, seat_count)
    }
    ranks["bank"] = seat_count
    return ranks


def _principal_creditor(shares: tuple[BankruptcyShare, ...]) -> Creditor:
    """The largest claim; the sole creditor in the ordinary case. ``max`` keeps the first
    maximum and ``shares`` is in settlement order, so ties resolve clockwise."""
    return max(shares, key=lambda share: share.claim).creditor


# --- The consequences of a transfer -----------------------------------------


def _charge_mortgage_transfer_fees(
    state: GameState, shares: tuple[BankruptcyShare, ...]
) -> tuple[GameState, tuple[Event, ...]]:
    """The official 10% on every mortgaged deed received (owner decision 2, G-13).

    Paid on the spot when the receiver can afford it, and otherwise a debt of their own —
    the creditor-side cascade, which is why a game can end with no survivor at all.
    """
    events: list[Event] = []
    for share in shares:
        receiver = share.creditor
        if receiver == "bank":
            continue
        fee = sum(
            mortgage_transfer_fee(state.board.tile(tile)) for tile in share.tiles if state.properties[tile].mortgaged
        )
        if not fee:
            continue
        if state.player(receiver).cash >= fee:
            state, paid = move_cash(
                state, source=receiver, dest="bank", amount=fee, reason=CashReason.MORTGAGE_TRANSFER_FEE
            )
            events.extend(paid)
        else:
            state, incurred = open_debt(
                state,
                debtor=receiver,
                creditor="bank",
                amount=fee,
                reason=CashReason.MORTGAGE_TRANSFER_FEE,
                resume=state.phase,
            )
            events.extend(incurred)
    return state, tuple(events)


def _liquidate_buildings(state: GameState, debtor: PlayerId) -> tuple[GameState, tuple[Event, ...]]:
    """Every building the debtor holds goes back to the bank at half price (the official
    rule), and the bank's stock goes back up with it."""
    events: list[Event] = []
    for tile_index in state.tiles_owned_by(debtor):
        prop = state.properties[tile_index]
        if not prop.houses:
            continue
        tile = state.board.tile(tile_index)
        refund = prop.houses * (tile.house_cost or 0) // 2
        state = update_property(state, tile_index, houses=0)
        events.append(BuildingChanged(tile=tile_index, houses=0, delta=-prop.houses))
        state, paid = move_cash(state, source="bank", dest=debtor, amount=refund, reason=CashReason.SELL_BUILDING)
        events.extend(paid)
    return state, tuple(events)


def _void_claims_of(state: GameState, player: PlayerId) -> tuple[GameState, tuple[Event, ...]]:
    """Drop every suspended claim a leaving player is a party to, and re-thread the stack.

    A pending trade they proposed or were offered is cancelled ``by="system"``: neither
    side can deliver, and a frame naming a bankrupt party is not a state the model accepts.
    A debt owed *to* them goes the same way — the money has nobody to reach, and
    ``GameState`` rejects a bankrupt creditor outright, so leaving it would be a crash
    rather than a rule. So does a debt owed *by* them, for the mirror-image reason: see
    :func:`_without_claims_of`, which is where all three judgements live.

    Removing a frame from the middle of the stack means the frame above it inherits the
    phase the dropped one had suspended; otherwise the game would resume into a phase it
    was never in. A bankruptcy needs *a* debt frame on top, but not the only one: a transfer
    fee charged on an estate can nest a second debt above the first, and MON-206's
    card-driven debts can nest above a trade review. Both shapes reach this function, and
    the deeper one deadlocked the game until MON-209's replay driver produced it.
    """
    events: list[Event] = []
    kept: list[InterruptFrame] = []
    inherited: Phase | None = None
    dropped = False
    for frame in state.interrupts:
        replacement = _without_claims_of(frame, player, events)
        if replacement is None:
            dropped = True
            inherited = frame.resume if inherited is None else inherited
            continue
        if replacement is not frame:
            dropped = True
        if inherited is not None:
            # ``push_interrupt`` re-stamps ``resume`` the same way; the field is a plain
            # enum, so the copy cannot skip a validator that matters.
            replacement = replacement.model_copy(update={"resume": inherited})
            inherited = None
        kept.append(replacement)
    if not dropped:
        return state, ()
    if kept:
        phase = PHASE_OF_FRAME[kept[-1].kind]
    elif inherited is not None:
        phase = inherited
    else:  # pragma: no cover - a frame was dropped, so an inherited resume always exists
        phase = state.phase
    return state._replace(interrupts=tuple(kept), phase=phase), tuple(events)


def _without_claims_of(frame: InterruptFrame, player: PlayerId, events: list[Event]) -> InterruptFrame | None:
    """``frame`` with ``player``'s claims removed, or None when nothing of it survives.

    An :class:`~kesef_engine.state.AuctionFrame` passes through untouched, and that is safe
    for one reason only: a bank auction and a player transfer are mutually exclusive (see the
    module docstring), so the leaving player is never among a live auction's bidders — their
    own estate auction is pushed *after* this runs, and it excludes them by construction. The
    safety is therefore contingent on that exclusivity rather than on anything checked here —
    nothing in the state model forbids a bankrupt bidder — so the branch below asserts it
    instead of assuming it. Without that assertion the contingency is an *absence*: if a rule
    ever opened an auction a debtor could bid in, this function would leave a bankrupt bidder
    standing in ``active`` and the failure would surface somewhere else entirely.
    """
    if isinstance(frame, AuctionFrame):
        # The contingency above, asserted rather than merely described. If a rule ever lets a
        # debt open on a live auction's bidder, this fails loudly here instead of quietly
        # leaving a bankrupt bidder in ``active`` for the auction to hand a lot to.
        assert player not in frame.active, f"player {player} is bidding in a live auction and going bankrupt"
        return frame
    if isinstance(frame, TradeFrame):
        if player in frame.player_ids():
            events.append(TradeCancelled(offer=frame.offer, by="system"))
            return None
        return frame
    if isinstance(frame, DebtFrame):
        if frame.debtor == player:
            # A debt owed *by* the leaver dies with them. They have conceded, and the estate
            # that would have answered this frame was already divided among the creditors of
            # the frame the bankruptcy popped — there is nothing left for a second frame to
            # reach, and the debtor is about to stop being a player at all. This is the exact
            # reciprocal of the branch below, where an obligation owed *to* the leaver is
            # dropped as uncollectable.
            #
            # Reachable, and it deadlocked before MON-209 caught it: a debt on A, A then
            # *receiving* a mortgaged deed, and the 10% transfer fee opens a second debt on A.
            # ``handle_declare_bankruptcy`` pops only the top frame, so conceding used to
            # leave ``[debt(debtor=A, bankrupt=True)]`` live, offering no legal command in a
            # phase that is not GAME_OVER. ``GameState._check_interrupts`` now rejects that
            # shape outright, so this branch is what keeps the state model satisfiable.
            return None
        if player in frame.creditors:
            surviving = tuple(obligation for obligation in frame.obligations if obligation.creditor != player)
            if not surviving:
                return None
            return DebtFrame(**{**dict(frame), "obligations": surviving})
    return frame


def _return_jail_cards(state: GameState, cards: tuple[Deck, ...]) -> GameState:
    """Jail cards go to the bottoms of their own decks (GAP G-11)."""
    for card in cards:
        if card is Deck.CHANCE:
            state = state._replace(chance_deck=(*state.chance_deck, GET_OUT_OF_JAIL_IDS[card]))
        else:
            state = state._replace(community_chest_deck=(*state.community_chest_deck, GET_OUT_OF_JAIL_IDS[card]))
    return state
