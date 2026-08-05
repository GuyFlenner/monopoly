"""What can be done right now.

This is the most important function in the project for UI quality (ADR-005). The client
does not decide whether the Build button is enabled — it asks here, and renders what it
is told. That single inversion removes the classic bug family where the UI and the rules
disagree about what is allowed, and it means a bot and a human are offered exactly the
same moves.

One source of truth: :func:`legal_commands` is a *filter* — it enumerates a bounded
candidate space per phase and keeps what :func:`is_legal` approves. No predicate is
written twice, so the two can never drift.

The three ADR-005 properties (as amended 2026-07-26):

1. **Soundness** — every command returned is accepted by ``apply`` (MON-102).
2. **Completeness over the 15 enumerable kinds** — every omitted command is rejected,
   specifically with a populated ``reason_key``.
3. **is_legal is the oracle for the rest** — the two unbounded parameter spaces keep
   their explicit exception: :class:`~kesef_engine.commands.PlaceBid` is enumerated at
   the minimum legal bid only, and :class:`~kesef_engine.commands.ProposeTrade` is never
   enumerated (the trade builder validates its draft through :func:`is_legal`).

Rejections carry i18n keys (``error.not_your_turn``), never prose, plus the context
params the catalogue sentence needs (G-33) — ``error.insufficient_funds`` says how much
short, and ``error.group_incomplete`` names the set.

A param that names something the catalogue can translate carries a **key**, not a value,
and is spelled ``<name>_key``: ``group_key="group.light_blue"``, ``deck_key="deck.chance"``.
That is MON-415's convention, shared with ``RentQuote.note_params``, and the client resolves
any ``*_key`` param without knowing what a ColorGroup is. Shipping ``group.value`` instead put
the engine's English identifier into a Hebrew sentence.

Not every param is destined for a sentence, and ``tests/test_key_contract.py`` is where each
is held to its purpose: it fails if a catalogue placeholder has no param behind it, **or** if
a param is neither interpolated nor listed there with a reason. ``tile`` is the standing
example of the second kind — an index a client uses to *highlight* the offending square
rather than to name it (MON-723).

Checks run in a fixed, documented order — game over, actor seated, actor solvent, phase,
whose turn, then the command-specific rules in reading order — so a rejection's
``reason_key`` is deterministic and goldens do not flap.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Self, assert_never

from pydantic import BaseModel, ConfigDict, model_validator

from kesef_engine.board.models import ColorGroup, Tile, TileKind
from kesef_engine.commands import (
    BuildHouse,
    BuyProperty,
    CancelTrade,
    Command,
    DeclareBankruptcy,
    DeclinePurchase,
    EndTurn,
    MortgageProperty,
    PayJailFine,
    PlaceBid,
    ProposeTrade,
    RespondToTrade,
    RollDice,
    RollForJail,
    SellHouse,
    TradeSide,
    UnmortgageProperty,
    UseJailCard,
    WithdrawFromAuction,
)
from kesef_engine.phases import PORTFOLIO_PHASES, Phase
from kesef_engine.primitives import PlayerId
from kesef_engine.state import HOTEL_LEVEL, AuctionFrame, DebtFrame, GameState, PlayerState, TradeFrame


class LegalityResult(BaseModel):
    """The answer to "may this command be sent right now?".

    Truthiness follows ``legal``, so call sites read ``if is_legal(state, command):``.
    An illegal result always carries a ``reason_key`` (an i18n key, never a sentence)
    and whatever params its catalogue entry interpolates.
    """

    model_config = ConfigDict(frozen=True)

    legal: bool
    reason_key: str | None = None
    params: dict[str, int | str] = {}

    def __bool__(self) -> bool:
        return self.legal

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.legal and self.reason_key is not None:
            raise ValueError("a legal result cannot carry a rejection reason")
        if not self.legal and not self.reason_key:
            raise ValueError("an illegal result must say why, as an i18n key")
        return self


_LEGAL = LegalityResult(legal=True)


def _no(reason_key: str, **params: int | str) -> LegalityResult:
    return LegalityResult(legal=False, reason_key=reason_key, params=params)


def unmortgage_cost(tile: Tile) -> int:
    """Mortgage value plus 10% interest, rounded up — the official lift fee (MON-202)."""
    value = tile.mortgage or 0
    return value + -(-value // 10)


def minimum_bid(frame: AuctionFrame) -> int:
    """The smallest bid ``apply`` would accept: the frame's floor, or one over the
    standing high bid, whichever is higher (MON-203: minimum increment is 1)."""
    return max(frame.min_bid, frame.high_bid + 1)


# --- is_legal ----------------------------------------------------------------


def is_legal(state: GameState, command: Command) -> LegalityResult:
    """Whether one specific command may be sent, and if not, why.

    The oracle behind :func:`legal_commands`, and the only validation path for the two
    unbounded command kinds (``PlaceBid`` amounts, ``ProposeTrade`` drafts). Legality is
    about what may be *commanded*; what then happens — a jail roll failing, a trade
    being voided — is ``apply``'s business.
    """
    if state.phase is Phase.GAME_OVER:
        return _no("error.game_over")
    try:
        actor = state.player(command.player)
    except KeyError:
        return _no("error.unknown_player", player=command.player)
    if actor.bankrupt:
        return _no("error.bankrupt", player=command.player)

    if isinstance(command, RollDice):
        return _current_player_gate(state, command.player, Phase.AWAITING_ROLL)
    if isinstance(command, EndTurn):
        # ``elapsed_seconds`` is caller-stamped wall-clock metadata (G-6), not a rule input.
        return _current_player_gate(state, command.player, Phase.AWAITING_END_TURN)
    if isinstance(command, BuyProperty):
        return _buy(state, actor)
    if isinstance(command, DeclinePurchase):
        return _decline(state, actor)
    if isinstance(command, PlaceBid):
        return _place_bid(state, command, actor)
    if isinstance(command, WithdrawFromAuction):
        return _auction_turn_gate(state, command.player)
    if isinstance(command, BuildHouse):
        return _build_house(state, command, actor)
    if isinstance(command, SellHouse):
        return _sell_house(state, command)
    if isinstance(command, MortgageProperty):
        return _mortgage(state, command)
    if isinstance(command, UnmortgageProperty):
        return _unmortgage(state, command, actor)
    if isinstance(command, ProposeTrade):
        return _propose_trade(state, command)
    if isinstance(command, RespondToTrade):
        return _trade_review_gate(state, command.player, respondent="recipient")
    if isinstance(command, CancelTrade):
        return _trade_review_gate(state, command.player, respondent="proposer")
    if isinstance(command, PayJailFine):
        return _pay_jail_fine(state, command, actor)
    if isinstance(command, UseJailCard):
        return _use_jail_card(state, command, actor)
    if isinstance(command, RollForJail):
        return _jail_gate(state, command.player, actor)
    if isinstance(command, DeclareBankruptcy):
        return _declare_bankruptcy(state, command.player)
    assert_never(command)


# --- Shared gates -------------------------------------------------------------


def _current_player_gate(state: GameState, player: PlayerId, phase: Phase) -> LegalityResult:
    if state.phase is not phase:
        return _no("error.wrong_phase", phase=state.phase.value)
    if player != state.current_player_id:
        return _no("error.not_your_turn")
    return _LEGAL


def _portfolio_gate(state: GameState, player: PlayerId, *, debt_ok: bool, auction_ok: bool) -> LegalityResult:
    """Who may manage a portfolio right now.

    Portfolio phases open the estate to **every** solvent player — the MON-204 design
    decision recorded in the backlog: portfolio actions do not wait for your turn, only
    for a quiet phase. No interrupt can be live there, the state validator guarantees
    it. The RAISING contexts are narrower: the debtor during DEBT_SETTLEMENT, the
    bidding turn during an AUCTION (G-B1a), each for cash-raising kinds only — and
    trading is DEBT_SETTLEMENT-only, since a live auction cannot be paused by a trade
    review (GAP G-5, as corrected).
    """
    if state.phase in PORTFOLIO_PHASES:
        return _LEGAL
    frame = state.top_interrupt
    if debt_ok and state.phase is Phase.DEBT_SETTLEMENT and isinstance(frame, DebtFrame):
        if player == frame.debtor:
            return _LEGAL
        return _no("error.not_the_debtor")
    if auction_ok and state.phase is Phase.AUCTION and isinstance(frame, AuctionFrame):
        if player == frame.turn:
            return _LEGAL
        return _no("error.not_your_bid_turn")
    return _no("error.wrong_phase", phase=state.phase.value)


def _auction_turn_gate(state: GameState, player: PlayerId) -> LegalityResult:
    frame = state.top_interrupt
    if state.phase is not Phase.AUCTION or not isinstance(frame, AuctionFrame):
        return _no("error.wrong_phase", phase=state.phase.value)
    if frame.turn is None or player != frame.turn:
        return _no("error.not_your_bid_turn")
    return _LEGAL


def _jail_gate(state: GameState, player: PlayerId, actor: PlayerState) -> LegalityResult:
    gate = _current_player_gate(state, player, Phase.JAIL_DECISION)
    if not gate:
        return gate
    if not actor.in_jail:
        return _no("error.not_in_jail")
    return _LEGAL


def _trade_review_gate(state: GameState, player: PlayerId, *, respondent: str) -> LegalityResult:
    frame = state.top_interrupt
    if state.phase is not Phase.TRADE_REVIEW or not isinstance(frame, TradeFrame):
        return _no("error.wrong_phase", phase=state.phase.value)
    if respondent == "recipient" and player != frame.offer.recipient:
        return _no("error.not_trade_recipient")
    if respondent == "proposer" and player != frame.offer.proposer:
        return _no("error.not_trade_proposer")
    return _LEGAL


# --- Buying --------------------------------------------------------------------


def _buy(state: GameState, actor: PlayerState) -> LegalityResult:
    gate = _purchase_decision_gate(state, actor)
    if not gate:
        return gate
    price = state.board.tile(actor.position).price or 0
    if actor.cash < price:
        return _no("error.insufficient_funds", required=price, available=actor.cash)
    return _LEGAL


def _decline(state: GameState, actor: PlayerState) -> LegalityResult:
    # Declining is free of conditions: with auctions disabled the tile simply stays
    # with the bank (MON-103), so no ruleset flag gates it.
    return _purchase_decision_gate(state, actor)


def _purchase_decision_gate(state: GameState, actor: PlayerState) -> LegalityResult:
    gate = _current_player_gate(state, actor.id, Phase.AWAITING_PURCHASE_DECISION)
    if not gate:
        return gate
    tile = state.board.tile(actor.position)
    if not tile.is_ownable:
        return _no("error.tile_not_ownable", tile=tile.index)
    if state.properties[tile.index].owner is not None:
        return _no("error.tile_already_owned", tile=tile.index)
    return _LEGAL


# --- Auction --------------------------------------------------------------------


def _place_bid(state: GameState, command: PlaceBid, actor: PlayerState) -> LegalityResult:
    gate = _auction_turn_gate(state, command.player)
    if not gate:
        return gate
    frame = state.top_interrupt
    assert isinstance(frame, AuctionFrame)  # the gate above proved it
    floor = minimum_bid(frame)
    if command.amount < floor:
        return _no("error.bid_too_low", minimum=floor)
    if frame.max_bid is not None and command.amount > frame.max_bid:
        return _no("error.bid_above_ceiling", maximum=frame.max_bid)
    if command.amount > actor.cash:
        return _no("error.insufficient_funds", required=command.amount, available=actor.cash)
    return _LEGAL


# --- Development ------------------------------------------------------------------


def _build_house(state: GameState, command: BuildHouse, actor: PlayerState) -> LegalityResult:
    gate = _portfolio_gate(state, command.player, debt_ok=False, auction_ok=False)
    if not gate:
        return gate
    tile = state.board.tile(command.tile)
    if tile.kind is not TileKind.PROPERTY:
        return _no("error.not_buildable", tile=command.tile)
    prop = state.properties[command.tile]
    if prop.owner != command.player:
        return _no("error.not_owner", tile=command.tile)
    group = tile.group
    assert group is not None  # a PROPERTY tile always carries one; the board validator enforces it
    if not state.owns_whole_group(command.player, group):
        return _no("error.group_incomplete", group_key=f"group.{group.value}")
    if any(state.properties[member].mortgaged for member in state.board.group_members(group)):
        return _no("error.group_mortgaged", group_key=f"group.{group.value}")
    if prop.houses >= HOTEL_LEVEL:
        return _no("error.at_maximum_development", tile=command.tile)
    if state.ruleset.even_build_enforced and prop.houses > min(_levels(state, group)):
        return _no("error.uneven_build", tile=command.tile)
    # The bank's stock is finite unconditionally: ``GameState._check_properties`` refuses a
    # state holding more buildings than the ruleset's ``houses_available`` /
    # ``hotels_available``, so a flag-gated check here would offer a build that ``apply``
    # could only answer with a ValidationError. How a *contested* last house is allotted is
    # the flag-governed part, and that is ``Ruleset.building_shortage_auction`` (off in v1:
    # first-come-first-served, owner decision 1). An "unlimited bank" variant raises
    # ``houses_available``; it does not switch the stock check off.
    if prop.houses == HOTEL_LEVEL - 1:
        # The fifth build erects the hotel; the four houses go back to the bank.
        if state.hotels_remaining < 1:
            return _no("error.no_hotels_left")
    elif state.houses_remaining < 1:
        return _no("error.no_houses_left")
    cost = tile.house_cost or 0
    if actor.cash < cost:
        return _no("error.insufficient_funds", required=cost, available=actor.cash)
    return _LEGAL


def _sell_house(state: GameState, command: SellHouse) -> LegalityResult:
    gate = _portfolio_gate(state, command.player, debt_ok=True, auction_ok=True)
    if not gate:
        return gate
    tile = state.board.tile(command.tile)
    if tile.kind is not TileKind.PROPERTY:
        return _no("error.not_buildable", tile=command.tile)
    prop = state.properties[command.tile]
    if prop.owner != command.player:
        return _no("error.not_owner", tile=command.tile)
    if prop.houses == 0:
        return _no("error.no_buildings", tile=command.tile)
    group = tile.group
    assert group is not None
    if command.demolish_hotel:
        # The whole-group sale. It needs no even-build check because it ends at zero
        # across the group, and every member is owned by the seller (a hotel implies a
        # complete group and nothing since could have split it — a group carrying
        # buildings cannot be traded or mortgaged).
        if prop.houses != HOTEL_LEVEL:
            return _no("error.no_hotel_to_demolish", tile=command.tile)
        return _LEGAL
    if state.ruleset.even_build_enforced and prop.houses < max(_levels(state, group)):
        return _no("error.uneven_build", tile=command.tile)
    if prop.houses == HOTEL_LEVEL and state.houses_remaining < HOTEL_LEVEL - 1:
        # A hotel comes down by *becoming* four houses, and the bank must hand them
        # over. When it cannot, the only sale left is the whole group (G-B3b) — which is
        # why ``demolish_hotel`` exists rather than this branch silently doing it.
        return _no("error.no_houses_left")
    return _LEGAL


def _levels(state: GameState, group: ColorGroup) -> tuple[int, ...]:
    """House counts across a group, a hotel counting as 5 — the even-build yardstick."""
    return tuple(state.properties[member].houses for member in state.board.group_members(group))


# --- Mortgages ----------------------------------------------------------------------


def _mortgage(state: GameState, command: MortgageProperty) -> LegalityResult:
    gate = _portfolio_gate(state, command.player, debt_ok=True, auction_ok=True)
    if not gate:
        return gate
    if not state.ruleset.mortgages_enabled:
        return _no("error.mortgages_disabled")
    tile = state.board.tile(command.tile)
    if not tile.is_ownable:
        return _no("error.tile_not_ownable", tile=command.tile)
    prop = state.properties[command.tile]
    if prop.owner != command.player:
        return _no("error.not_owner", tile=command.tile)
    if prop.mortgaged:
        return _no("error.already_mortgaged", tile=command.tile)
    if tile.group is not None and any(_levels(state, tile.group)):
        return _no("error.group_has_buildings", group_key=f"group.{tile.group.value}")
    return _LEGAL


def _unmortgage(state: GameState, command: UnmortgageProperty, actor: PlayerState) -> LegalityResult:
    # Not a RAISING kind: a player who owes money may not tie more of it up (G-5).
    gate = _portfolio_gate(state, command.player, debt_ok=False, auction_ok=False)
    if not gate:
        return gate
    if not state.ruleset.mortgages_enabled:
        return _no("error.mortgages_disabled")
    tile = state.board.tile(command.tile)
    if not tile.is_ownable:
        return _no("error.tile_not_ownable", tile=command.tile)
    prop = state.properties[command.tile]
    if prop.owner != command.player:
        return _no("error.not_owner", tile=command.tile)
    if not prop.mortgaged:
        return _no("error.not_mortgaged", tile=command.tile)
    cost = unmortgage_cost(tile)
    if actor.cash < cost:
        return _no("error.insufficient_funds", required=cost, available=actor.cash)
    return _LEGAL


# --- Trading --------------------------------------------------------------------------


def _propose_trade(state: GameState, command: ProposeTrade) -> LegalityResult:
    gate = _portfolio_gate(state, command.player, debt_ok=True, auction_ok=False)
    if not gate:
        return gate
    if not state.ruleset.trading_enabled:
        return _no("error.trading_disabled")
    offer = command.offer
    if command.player != offer.proposer:
        return _no("error.not_your_offer")
    try:
        recipient = state.player(offer.recipient)
    except KeyError:
        return _no("error.unknown_player", player=offer.recipient)
    if recipient.bankrupt:
        return _no("error.recipient_bankrupt", player=offer.recipient)
    if state.ruleset.simplified_trades:
        for side in (offer.give, offer.receive):
            if len(side.tiles) + len(side.jail_cards) + (1 if side.cash else 0) > 1:
                return _no("error.trade_too_complex")
    proposer = state.player(offer.proposer)
    give = _trade_side(state, proposer, offer.give)
    if not give:
        return give
    return _trade_side(state, recipient, offer.receive)


def _trade_side(state: GameState, party: PlayerState, side: TradeSide) -> LegalityResult:
    """One party's half of an offer: they must hold what the offer moves. Mortgaged
    tiles transfer with their obligation; a group carrying buildings blocks every
    member, built or not (MON-204)."""
    if side.cash > party.cash:
        return _no("error.insufficient_funds", required=side.cash, available=party.cash)
    for index in side.tiles:
        tile = state.board.tile(index)
        if not tile.is_ownable:
            return _no("error.tile_not_ownable", tile=index)
        if state.properties[index].owner != party.id:
            return _no("error.not_owner", tile=index)
        if tile.group is not None and any(_levels(state, tile.group)):
            return _no("error.group_has_buildings", group_key=f"group.{tile.group.value}")
    for card in side.jail_cards:
        if card not in party.jail_cards:
            return _no("error.jail_card_not_held", deck_key=f"deck.{card.value}")
    return _LEGAL


# --- Jail ------------------------------------------------------------------------------


def _pay_jail_fine(state: GameState, command: PayJailFine, actor: PlayerState) -> LegalityResult:
    gate = _jail_gate(state, command.player, actor)
    if not gate:
        return gate
    fine = state.ruleset.jail_fine
    if actor.cash < fine:
        return _no("error.insufficient_funds", required=fine, available=actor.cash)
    return _LEGAL


def _use_jail_card(state: GameState, command: UseJailCard, actor: PlayerState) -> LegalityResult:
    gate = _jail_gate(state, command.player, actor)
    if not gate:
        return gate
    if not actor.jail_cards:
        return _no("error.no_jail_card")
    return _LEGAL


# --- Insolvency --------------------------------------------------------------------------


def _declare_bankruptcy(state: GameState, player: PlayerId) -> LegalityResult:
    frame = state.top_interrupt
    if state.phase is not Phase.DEBT_SETTLEMENT or not isinstance(frame, DebtFrame):
        return _no("error.wrong_phase", phase=state.phase.value)
    if player != frame.debtor:
        return _no("error.not_the_debtor")
    return _LEGAL


# --- legal_commands ------------------------------------------------------------------------


def legal_commands(state: GameState) -> tuple[Command, ...]:
    """Every command that is legal in ``state``, for every player who may act.

    Includes concrete parameters — ``BuildHouse(tile=16)``, not "you may build
    somewhere" — so the UI can bind a button straight to a command. Exhaustive for every
    phase, including the interrupt phases where the actor is not the current player.
    The two unbounded parameter spaces keep their ADR-005 exception:
    :class:`~kesef_engine.commands.PlaceBid` appears at the minimum legal bid only, and
    :class:`~kesef_engine.commands.ProposeTrade` is never enumerated — the trade builder
    validates its own draft via :func:`is_legal`. ``EndTurn`` appears with
    ``elapsed_seconds=None``; any caller-stamped value is equally legal.

    The order is deterministic — sorted by kind, actor, then parameter — so goldens and
    snapshot tests never flap. Cost is O(board × players): candidates are enumerated
    directly from holdings and the live frame, never searched for.
    """
    candidates = sorted(_candidates(state), key=_sort_key)
    return tuple(command for command in candidates if is_legal(state, command))


def _candidates(state: GameState) -> Iterator[Command]:
    """A small, bounded superset of what could possibly be legal right now.

    Correctness lives in :func:`is_legal`; this only has to *cover* it for the 15
    enumerable kinds (over-generation is filtered away, omission would be a bug — the
    property tests in ``test_legality_properties.py`` hold the two halves together).
    """
    current = state.current_player_id
    yield RollDice(player=current)
    yield EndTurn(player=current)
    yield BuyProperty(player=current)
    yield DeclinePurchase(player=current)
    yield PayJailFine(player=current)
    yield UseJailCard(player=current)
    yield RollForJail(player=current)

    frame = state.top_interrupt
    if isinstance(frame, AuctionFrame) and frame.turn is not None:
        yield PlaceBid(player=frame.turn, amount=minimum_bid(frame))
        yield WithdrawFromAuction(player=frame.turn)
    elif isinstance(frame, DebtFrame):
        yield DeclareBankruptcy(player=frame.debtor)
    elif isinstance(frame, TradeFrame):
        yield RespondToTrade(player=frame.offer.recipient, accept=True)
        yield RespondToTrade(player=frame.offer.recipient, accept=False)
        yield CancelTrade(player=frame.offer.proposer)

    for player in state.players:
        if player.bankrupt:
            continue
        for tile_index in state.tiles_owned_by(player.id):
            yield BuildHouse(player=player.id, tile=tile_index)
            yield SellHouse(player=player.id, tile=tile_index)
            yield SellHouse(player=player.id, tile=tile_index, demolish_hotel=True)
            yield MortgageProperty(player=player.id, tile=tile_index)
            yield UnmortgageProperty(player=player.id, tile=tile_index)


def _sort_key(command: Command) -> tuple[str, int, int, int]:
    detail = 0
    variant = 0
    if isinstance(command, BuildHouse | SellHouse | MortgageProperty | UnmortgageProperty):
        detail = command.tile
        if isinstance(command, SellHouse):
            variant = int(command.demolish_hotel)
    elif isinstance(command, PlaceBid):
        detail = command.amount
    elif isinstance(command, RespondToTrade):
        detail = int(command.accept)
    return (command.kind, command.player, detail, variant)
