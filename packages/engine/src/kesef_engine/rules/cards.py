"""Chance and Community Chest (MON-206).

The decks and their effects are data in :mod:`kesef_engine.decks`. This module is the only
thing that knows how to *enact* a step, and it owns three rules that are easy to get wrong:

* **a movement card that passes GO pays the salary; being sent to jail pays nothing**
  (spec §3.6 trap 10). The two live in different steps for exactly that reason.
* **the "advance to the nearest ..." cards price rent differently** — twice the rental for
  a railroad, and for a utility a roll made *for the rent* rather than the roll that moved
  the token (trap 9). Both go through :mod:`kesef_engine.rules.rent`; neither reimplements
  a rent table.
* **a drawn card returns to the bottom of its own deck** — except the two keepable jail
  cards, which leave the pile until they are used or forfeited and then return to the
  bottom of *that* deck (GAP G-11).

**How a half-finished card survives a debt (ADR-007 G-9).** A card's effect is a tuple of
steps. Resolution pushes a :class:`~kesef_engine.state.CardFrame` recording ``step``, and
runs steps until they are exhausted. A step that cannot be paid pushes a
:class:`~kesef_engine.state.DebtFrame` *on top of* the card frame, and the reducer resumes
the card — at the step it stopped at — the moment that debt settles. "Collect ₪10 from
every player" is the case this exists for: one payer's insolvency must not cancel the
collection from the next.

The frame steps off the stack before the card's **last** step. A step that resolves a
landing decides where the turn comes to rest (an arrival on an unowned tile rests in
``AWAITING_PURCHASE_DECISION``), and ``GameState`` ties ``phase`` to the live frame — so a
step that chooses the resting phase cannot run underneath a card frame. The frame's job is
to carry *remaining* work, and by the last step there is none.
"""

from __future__ import annotations

from typing import assert_never

from kesef_engine.board.models import BOARD_SIZE, TileKind
from kesef_engine.decks import (
    CARD_EFFECTS,
    GET_OUT_OF_JAIL_IDS,
    AdvanceTo,
    AdvanceToNearestRailroad,
    AdvanceToNearestUtility,
    CardStep,
    Collect,
    CollectFrom,
    CollectFromEachPlayer,
    GoBack,
    GoToJail,
    KeepJailCard,
    Pay,
    PayEachPlayer,
    Repairs,
)
from kesef_engine.events import CardDrawn, DebtIncurred, Event
from kesef_engine.phases import Phase
from kesef_engine.primitives import CashReason, Deck, PlayerId, TileIndex
from kesef_engine.rules import movement, rent, tiles
from kesef_engine.rules.cash import move_cash
from kesef_engine.rules.common import post_move_phase, send_to_jail, update_player
from kesef_engine.state import HOTEL_LEVEL, CardFrame, DebtFrame, GameState, Obligation

DECK_OF_TILE: dict[TileKind, Deck] = {
    TileKind.CHANCE: Deck.CHANCE,
    TileKind.COMMUNITY_CHEST: Deck.COMMUNITY_CHEST,
}
"""Which pile a card tile deals from. The tile router's only card-specific knowledge."""


# --- Drawing ----------------------------------------------------------------


def draw_and_resolve(state: GameState, player_id: PlayerId, deck: Deck) -> tuple[GameState, tuple[Event, ...]]:
    """Deal the top card of ``deck`` to ``player_id`` and resolve it to a resting phase.

    Called by the tile router, so it always returns a state a caller may observe: either
    the turn's resting phase, or ``DEBT_SETTLEMENT`` over a suspended card frame.
    """
    pile = state.deck(deck)
    card_id = pile[0] if pile else None
    if card_id is None or card_id not in CARD_EFFECTS:
        # ``new_game`` stocks both decks with ids the effect table covers (pinned by test),
        # and nothing but a kept jail card ever leaves a deck — so in play a pile is never
        # empty and never holds an id with no effect. Both shapes are *representable* by a
        # hand-built state, and a deck that cannot deal deals nothing rather than raising.
        return state._replace(phase=post_move_phase(state, player_id)), ()

    state = _restock(state, deck, pile[1:] if _is_keepable(card_id) else (*pile[1:], card_id))
    frame = CardFrame(resume=post_move_phase(state, player_id), card_id=card_id, deck=deck)
    # The resume is recorded by ``push_interrupt`` from the phase it suspends, so the
    # phase is set to where the turn will rest *before* the card goes on the stack.
    state = state._replace(phase=frame.resume).push_interrupt(frame)
    state, produced = _run_remaining(state, player_id)
    return state, (CardDrawn(player=player_id, deck=deck, card_id=card_id), *produced)


def resume(state: GameState) -> tuple[GameState, tuple[Event, ...]]:
    """Continue the live card after a debt it opened has settled (ADR-007 G-9).

    Called by the reducer, which is the only place that knows the debt is paid. The card's
    subject is the current player: a card is drawn on its holder's turn and the turn cannot
    be handed on while an interrupt is live.
    """
    return _run_remaining(state, state.current_player_id)


def _run_remaining(state: GameState, player_id: PlayerId) -> tuple[GameState, tuple[Event, ...]]:
    events: list[Event] = []
    while True:
        frame = state.top_interrupt
        assert isinstance(frame, CardFrame), "the card runner only ever runs under its own frame"
        steps = _steps(state, frame.card_id, player_id)
        remaining = steps[frame.step :]
        assert remaining, "a card frame outlived its effect: a step failed to pop it"
        if len(remaining) == 1:
            # The last step decides where the turn rests, so the frame steps off first.
            state = state.pop_interrupt()
            state, produced = _apply_step(state, remaining[0], player_id, frame.deck)
            return state, (*events, *produced)
        state = _at_step(state, frame.step + 1)
        state, produced = _apply_step(state, remaining[0], player_id, frame.deck)
        events.extend(produced)
        if state.phase is not Phase.CARD_RESOLUTION:
            return state, tuple(events)  # a debt suspended the card; the reducer resumes it


def _steps(state: GameState, card_id: str, player_id: PlayerId) -> tuple[CardStep, ...]:
    """The card's steps, with the per-player collections expanded.

    The expansion walks ``state.players``, whose length and order never change — a seat
    survives its own bankruptcy — so ``CardFrame.step`` still indexes the same step after a
    payer has gone under. A bankrupt payer's step is a no-op rather than a missing one.
    """
    expanded: list[CardStep] = []
    for step in CARD_EFFECTS[card_id]:
        if isinstance(step, CollectFromEachPlayer):
            expanded.extend(
                CollectFrom(payer=player.id, amount=step.amount) for player in state.players if player.id != player_id
            )
        else:
            expanded.append(step)
    return tuple(expanded)


def _at_step(state: GameState, step: int) -> GameState:
    """Record how much of the live card has been applied, rebuilding the frame so the
    result is a state a save file could restore."""
    frame = state.top_interrupt
    assert isinstance(frame, CardFrame)
    advanced = CardFrame(**(dict(frame) | {"step": step}))
    return state._replace(interrupts=(*state.interrupts[:-1], advanced))


def _is_keepable(card_id: str) -> bool:
    return card_id in GET_OUT_OF_JAIL_IDS.values()


def _restock(state: GameState, deck: Deck, pile: tuple[str, ...]) -> GameState:
    field = "chance_deck" if deck is Deck.CHANCE else "community_chest_deck"
    return state._replace(**{field: pile})


# --- Enacting one step ------------------------------------------------------


def _apply_step(
    state: GameState, step: CardStep, player_id: PlayerId, deck: Deck
) -> tuple[GameState, tuple[Event, ...]]:
    match step:
        case Collect():
            return move_cash(state, source="bank", dest=player_id, amount=step.amount, reason=CashReason.CARD)
        case Pay():
            return _charge(state, player_id, (Obligation(creditor="bank", amount=step.amount),))
        case Repairs():
            return _charge(state, player_id, _assessment(state, player_id, step))
        case PayEachPlayer():
            return _charge(state, player_id, _per_player(state, player_id, step.amount))
        case CollectFrom():
            if state.player(step.payer).bankrupt:
                return state, ()
            return _charge(state, step.payer, (Obligation(creditor=player_id, amount=step.amount),))
        case AdvanceTo():
            return _advance(state, player_id, step.tile)
        case GoBack():
            return _go_back(state, player_id, step.spaces)
        case AdvanceToNearestRailroad():
            return _advance_to_nearest(state, player_id, TileKind.RAILROAD, doubles_rent=True)
        case AdvanceToNearestUtility():
            return _advance_to_nearest(
                state, player_id, TileKind.UTILITY, rolls_for_rent=True, utility_multiplier=step.multiplier
            )
        case GoToJail():
            state, jailed = send_to_jail(state, player_id, via="card")
            # Recomputed rather than taken from the frame's resume: a card drawn after a
            # doubles roll would otherwise be offered another roll from the cell (trap 7's
            # sibling, GAP G-12).
            return state._replace(phase=post_move_phase(state, player_id)), jailed
        case KeepJailCard():
            held = state.player(player_id).jail_cards
            return update_player(state, player_id, jail_cards=(*held, deck)), ()
        case CollectFromEachPlayer():  # pragma: no cover - expanded away by ``_steps``
            raise AssertionError("CollectFromEachPlayer must be expanded before it is applied")
        case _:  # pragma: no cover - the union is closed
            assert_never(step)


def _assessment(state: GameState, player_id: PlayerId, step: Repairs) -> tuple[Obligation, ...]:
    """A per-building charge over the holder's estate. A hotel is one hotel, never five
    houses — the same distinction ``GameState.houses_on_board`` draws."""
    houses = hotels = 0
    for index in state.tiles_owned_by(player_id):
        built = state.properties[index].houses
        if built == HOTEL_LEVEL:
            hotels += 1
        else:
            houses += built
    total = houses * step.per_house + hotels * step.per_hotel
    return (Obligation(creditor="bank", amount=total),) if total else ()


def _per_player(state: GameState, player_id: PlayerId, amount: int) -> tuple[Obligation, ...]:
    """One obligation per other solvent player, in seat order (GAP G-7). A player who has
    left the game is owed nothing, and a ``DebtFrame`` may not name them as a creditor."""
    return tuple(
        Obligation(creditor=player.id, amount=amount)
        for player in state.players
        if player.id != player_id and not player.bankrupt
    )


def _charge(
    state: GameState, debtor: PlayerId, obligations: tuple[Obligation, ...]
) -> tuple[GameState, tuple[Event, ...]]:
    """Pay ``obligations`` in cash, or open one debt holding all of them.

    The multi-creditor sibling of :func:`kesef_engine.rules.insolvency.open_debt`, which
    takes a single creditor and so cannot express "pay each player" — one debt with up to
    five obligations, not five debts (GAP G-7). The affordable branch pays directly, as
    rent and tax do: a ``DebtFrame`` means "owes and cannot pay", and emitting one for a
    payment the holder can make would make the debt events lie.
    """
    if not obligations:
        return state, ()
    total = sum(obligation.amount for obligation in obligations)
    if state.player(debtor).cash >= total:
        events: list[Event] = []
        for obligation in obligations:
            state, paid = move_cash(
                state, source=debtor, dest=obligation.creditor, amount=obligation.amount, reason=CashReason.CARD
            )
            events.extend(paid)
        return state, tuple(events)
    # ``push_interrupt`` records the phase it suspends as the frame's resume, which is the
    # turn's resting phase for a last step and ``CARD_RESOLUTION`` for a step with work
    # after it — exactly the two continuations G-9 asks for.
    frame = DebtFrame(resume=state.phase, debtor=debtor, obligations=obligations, reason=CashReason.CARD)
    return state.push_interrupt(frame), tuple(
        DebtIncurred(debtor=debtor, creditor=obligation.creditor, amount=obligation.amount)
        for obligation in obligations
    )


# --- Movement ---------------------------------------------------------------


def _advance(state: GameState, player_id: PlayerId, target: TileIndex) -> tuple[GameState, tuple[Event, ...]]:
    """Walk forward to ``target``. Forward, always: "advance to GO" from tile 36 goes the
    four steps round the corner and collects the salary, it does not step back 36."""
    forward = (target - state.player(player_id).position) % BOARD_SIZE
    state, moved = movement.move_token(state, player_id, forward)
    state, resolved = tiles.resolve_landing(state, player_id)
    return state, (*moved, *resolved)


def _go_back(state: GameState, player_id: PlayerId, spaces: int) -> tuple[GameState, tuple[Event, ...]]:
    """Walk backwards and resolve the arrival — which may itself be a card tile: three
    spaces back from the last Chance tile is a Community Chest tile, and it deals."""
    state, moved = movement.move_token_back(state, player_id, spaces)
    state, resolved = tiles.resolve_landing(state, player_id)
    return state, (*moved, *resolved)


def _advance_to_nearest(
    state: GameState,
    player_id: PlayerId,
    kind: TileKind,
    *,
    doubles_rent: bool = False,
    rolls_for_rent: bool = False,
    utility_multiplier: int | None = None,
) -> tuple[GameState, tuple[Event, ...]]:
    target = _nearest(state, player_id, kind)
    forward = (target - state.player(player_id).position) % BOARD_SIZE
    state, moved = movement.move_token(state, player_id, forward)
    if state.properties[target].owner is None:
        # "If it is unowned you may buy it from the bank" — the special pricing applies to
        # the rent, never to the sale, so an unowned arrival is the router's ordinary one.
        state, resolved = tiles.resolve_landing(state, player_id)
        return state, (*moved, *resolved)
    state, charged = rent.charge(
        state,
        player_id,
        target,
        roll_for_amount=rolls_for_rent,
        card_doubles_rent=doubles_rent,
        utility_multiplier=utility_multiplier,
    )
    return state, (*moved, *charged)


def _nearest(state: GameState, player_id: PlayerId, kind: TileKind) -> TileIndex:
    """The next tile of ``kind`` in the direction of travel, wrapping past GO."""
    position = state.player(player_id).position
    candidates = state.board.indexes_of_kind(kind)
    assert candidates, f"the board carries no {kind} tile for a card to advance to"
    return min(candidates, key=lambda index: (index - position) % BOARD_SIZE or BOARD_SIZE)
