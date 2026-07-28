"""Repo-level checks that do not belong to a single package.

Locale parity is the one that earns its keep: a key present in English and missing in
Hebrew is invisible in development (English is the fallback) and shows up as untranslated
text in front of a Hebrew-speaking child. A JSON diff catches it in a second.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

LOCALES_DIR = Path(__file__).resolve().parent.parent / "packages" / "web" / "src" / "i18n" / "locales"
CATALOGUES = ("common", "board-classic", "cards")
LANGUAGES = ("en", "he")

# "cards" ships English-only for now: 31 cards of Hebrew need a native-speaker pass rather
# than a machine-plausible guess (MON-506), the same reasoning MON-503 applies to the
# Israeli board. Every parity check that compares English against Hebrew is skipped for a
# catalogue listed here; the tripwire test below still asserts the Hebrew file is absent so
# the exemption cannot be quietly forgotten once MON-506 lands.
ENGLISH_ONLY_CATALOGUES = ("cards",)

_NARRATION_AWAITING_HEBREW = frozenset(
    {
        "a11y.moved",
        "a11y.passed_go",
        "a11y.rent_charged",
        "a11y.cash_gained",
        "a11y.cash_paid",
        "a11y.turn",
        "a11y.phase_auction",
        "a11y.phase_debt_settlement",
        "a11y.phase_trade_review",
        # MON-412 themed the six ownable tiles the engine leaves ``group=None`` (GAP G-A3).
        # Their Hebrew needs adjective agreement, which MON-501 owns — see G-F8: the Hebrew
        # catalogue inflects a colour name across an interpolation boundary and gets three of
        # eight groups wrong, so guessing two more here would add to a known defect.
        "group.railroad",
        "group.utility",
    }
)
"""MON-411's narration sentences. Every one has a subject, and Hebrew conjugates the verb to the
subject's gender (GAP G-42): ``רותי עבר`` is wrong for every Hebrew speaker, and wrong in a
children's game is worse than absent."""

_EVENT_LOG_AWAITING_HEBREW = frozenset(
    {
        # The written history (MON-407) — one sentence per event type, plus the enum labels the
        # sentences interpolate. Same reason as the narration above: `log.token_moved` is
        # "{{name}} moved to {{tile}}", a verb agreeing with a person, so its Hebrew needs the
        # i18next gender context MON-501 owns rather than a machine-plausible masculine.
        "log.auction_ended",
        "log.auction_ended_unsold",
        "log.auction_started",
        "log.bid_placed",
        "log.bidder_withdrew",
        "log.building_built_one",
        "log.building_built_other",
        "log.building_sold_one",
        "log.building_sold_other",
        "log.card_drawn",
        "log.cash_gained",
        "log.cash_paid",
        "log.debt_incurred",
        "log.debt_settled",
        "log.dice_rolled_jail",
        "log.dice_rolled_move",
        "log.dice_rolled_rent",
        "log.empty",
        "log.game_ended",
        "log.game_ended_no_winner",
        "log.left_jail_card",
        "log.left_jail_doubles",
        "log.left_jail_fine",
        "log.left_jail_time_served",
        "log.mortgaged",
        "log.player_bankrupted",
        "log.property_acquired_auction",
        "log.property_acquired_bankruptcy",
        "log.property_acquired_purchase",
        "log.property_acquired_trade",
        "log.rent_charged",
        "log.sent_to_jail_card",
        "log.sent_to_jail_three_doubles",
        "log.sent_to_jail_tile",
        "log.title",
        "log.token_moved",
        "log.token_moved_back",
        "log.token_moved_passed_go",
        "log.trade_cancelled_proposer",
        "log.trade_cancelled_system",
        "log.trade_declined",
        "log.trade_executed",
        "log.trade_proposed",
        "log.turn_started",
        "log.unknown_tile",
        "log.unmortgaged",
        # Enum labels. A ``CashReason`` interpolated raw would print the English
        # ``mortgage_transfer_fee`` inside a Hebrew sentence (GAP A5), so each enum member gets a
        # key — and each key needs a noun phrase that agrees with the sentence carrying it,
        # which is the same MON-501 pass.
        "auction_reason.bankruptcy_to_bank",
        "auction_reason.building_shortage",
        "auction_reason.declined_purchase",
        "building.hotel",
        "building.house",
        "cash_reason.auction_win",
        "cash_reason.bankruptcy_transfer",
        "cash_reason.build",
        "cash_reason.card",
        "cash_reason.free_parking_pot",
        "cash_reason.go_salary",
        "cash_reason.jail_fine",
        "cash_reason.mortgage",
        "cash_reason.mortgage_transfer_fee",
        "cash_reason.purchase",
        "cash_reason.rent",
        "cash_reason.sell_building",
        "cash_reason.tax",
        "cash_reason.trade",
        "cash_reason.unmortgage",
        "deck.chance",
        "deck.community_chest",
        "game_end_reason.concession",
        "game_end_reason.last_solvent",
        "game_end_reason.no_survivors",
        "game_end_reason.time_limit",
        # The snake_case form the engine actually emits (``rules/rent.py``). The catalogue's
        # ``rent.note.fullGroupDoubled`` is the camelCase key GAP G-40 says resolves against
        # nothing; both spellings exist until that rename lands, and only the new one is listed
        # here because the old one already has Hebrew.
        "rent.note.full_group_doubled",
    }
)

_SETUP_AWAITING_HEBREW = frozenset(
    {
        # The setup screen (MON-408). The rule-flag labels exist so Kids mode can show what it
        # changes by rendering ``/rulesets`` instead of a hardcoded sentence; Hebrew needs
        # gendered adjective agreement per flag, not a word-for-word pass.
        "ruleset.auctions_enabled",
        "ruleset.building_shortage_auction",
        "ruleset.double_salary_on_exact_go",
        "ruleset.even_build_enforced",
        "ruleset.free_parking_pot_enabled",
        "ruleset.go_salary",
        "ruleset.hints_enabled",
        "ruleset.hotels_available",
        "ruleset.houses_available",
        "ruleset.jail_fine",
        "ruleset.max_jail_turns",
        "ruleset.mortgages_enabled",
        "ruleset.name",
        "ruleset.previous",
        "ruleset.simplified_trades",
        "ruleset.starting_cash",
        "ruleset.starting_cash_denominations",
        "ruleset.target_duration_minutes",
        "ruleset.trading_enabled",
        "ruleset.value.none",
        "ruleset.value.off",
        "ruleset.value.on",
        "setup.cannotStart",
        "setup.kidsChanges",
        "setup.kidsNoChanges",
        "setup.playerType",
        "setup.pronoun",
        "setup.seat",
        "setup.seats",
        "setup.seed",
        "setup.seedHint",
        "setup.starting",
        "setup.table",
        "setup.token",
        # The pronoun picker's labels. ``grammatical_gender`` exists on ``SeatConfig`` precisely
        # so Hebrew narration can agree (owner decision 5) — these three labels are the *first*
        # thing MON-501 needs, and guessing them here would prejudge that work.
        "gender.f",
        "gender.m",
        "gender.n",
        # Server rejection keys the setup screen renders. The engine and the transport own the
        # wording of *why* a game would not start; the Hebrew arrives with the rest of
        # ``error.*``, which is still half camelCase (G-40).
        "error.invalid_new_game",
        "error.malformed_request",
        "error.unknown_board",
        # The playing pieces. Each is a common noun with a gender in Hebrew, and the noun's
        # gender is what the sentences naming it have to agree with — so these belong with the
        # rest of MON-501 rather than beside their English, and they are a MON-412 stand-in in
        # any case (see ``SetupScreen.tsx``).
        "token.bicycle",
        "token.boat",
        "token.drum",
        "token.kite",
        "token.rocket",
        "token.umbrella",
    }
)

_BOARD = frozenset(
    {
        # MON-403's board chrome and the ten tile-kind names. Hebrew is withheld rather than guessed
        # for the same reason as the narration below: "street", "railroad" and "utility" all take a
        # definite article that agrees with the noun's gender, and G-F8 records that the existing
        # Hebrew catalogue already inflects a colour name across an interpolation boundary and gets
        # three of eight groups wrong. Adding ten more inflected nouns from a non-speaker would
        # deepen a known defect. MON-501 owns the Hebrew catalogue and the i18next gender context.
        "board.label",
        "board.skipToActions",
        "board.keyboardHint",
        "board.openTile",
        "board.moreTokens",
        "tileKind.go",
        "tileKind.property",
        "tileKind.railroad",
        "tileKind.utility",
        "tileKind.chance",
        "tileKind.community_chest",
        "tileKind.tax",
        "tileKind.jail",
        "tileKind.free_parking",
        "tileKind.go_to_jail",
        # The square's spoken description. Every one of these is a clause appended to a sentence
        # about a named square, so word order and agreement are a translator's decision, not a
        # concatenation a developer can guess at.
        "a11y.tileOneHouse",
        "a11y.tileHouses",
        "a11y.tileHotel",
        "a11y.tileMortgaged",
        "a11y.tileOccupants",
    }
)
"""MON-403's English-only keys — the board's chrome, tile kinds and spoken square description."""

_DICE = frozenset(
    {
        # MON-404's dice tray and the persistent "skip animations" switch. Same reason as _BOARD:
        # "roll for doubles to leave jail" and "your device already asks for reduced motion" are
        # sentences, not labels, and MON-501 owns the Hebrew catalogue.
        "dice.label",
        "dice.total",
        "dice.doubles",
        "dice.notRolled",
        "dice.purpose.move",
        "dice.purpose.jail",
        "dice.purpose.rent",
        "dice.skipAnimations",
        "dice.reducedMotionActive",
        # Announced through the Announcer when the player flips the switch, so these carry the same
        # gender-agreement problem as every other narration key (G-42).
        "a11y.animationsOn",
        "a11y.animationsOff",
    }
)
"""MON-404's English-only keys — the dice tray and the animation switch."""

_PANELS = frozenset(
    {
        # MON-405's ActionBar. Five of these are labels for command kinds the catalogue never had
        # a leaf for at all (``respond_to_trade`` and ``cancel_trade``), or for a payload variant
        # of one it did (``sell_house`` with ``demolish_hotel``), or a price-free replacement for
        # ``action.buy`` whose ``{{price}}`` nothing on the wire can supply — see
        # ``panels/ActionLabels.ts``. Every one is an imperative verb addressed to a player, and
        # Hebrew inflects the imperative for the addressee's gender (GAP G-42), which is exactly
        # the i18next gender context MON-501 owns.
        "action.buy_property",
        "action.cancel_trade",
        "action.respond_to_trade_accept",
        "action.respond_to_trade_decline",
        "action.sellHouse_hotel",
        "actionbar.choose_square",
        "actionbar.label",
        "actionbar.none",
        # The terminal-command confirm step (GAP C3). These are full sentences explaining a
        # consequence to a child, which is the hardest register in the product to get right in a
        # second language and the worst place to ship a machine-plausible guess: the whole point
        # of the step is that the player understands what they are about to lose.
        "confirm.cancel",
        "confirm.consequence.declare_bankruptcy",
        "confirm.consequence.decline_purchase",
        "confirm.consequence.withdraw_from_auction",
        "confirm.proceed",
        "confirm.title",
        # MON-406's dossier. ``dossier.title``/``completeSet``/``setProgress``/``empty`` already
        # have Hebrew and are reused as they are; only the three new leaves are here.
        "dossier.bot",
        "dossier.other_holdings",
        "dossier.seat",
        # Shared labels both panels interpolate a count into. Hebrew pluralises on one/two/many
        # rather than one/other, so the plural *shape* differs and not just the words — i18next
        # needs ``_one``/``_two``/``_many`` keys here, which is a catalogue decision MON-501 owns.
        "label.squares_one",
        "label.squares_other",
        "label.unknown_square",
    }
)
"""MON-405/MON-406's English-only keys — the action bar, the confirm step and the dossier."""

AWAITING_HEBREW = (
    _NARRATION_AWAITING_HEBREW | _EVENT_LOG_AWAITING_HEBREW | _SETUP_AWAITING_HEBREW | _BOARD | _DICE | _PANELS
)
"""Individual English keys whose Hebrew is owned by a later item, listed one by one.

Split by the item that added them, because the *reason* is what has to survive review, and the
groups share one: every sentence has a subject, and Hebrew conjugates the verb to the
subject's gender (GAP G-42). ``רותי עבר`` is wrong for every Hebrew speaker, and wrong in a
children's game is worse than absent. MON-501/MON-506 own the Hebrew catalogue and the i18next
gender context that makes these sayable.

A per-key list rather than a ``log.*``/``ruleset.*`` prefix exemption, and a tripwire test below,
so the exemption cannot outlive its reason: a key that gains Hebrew, or that stops existing in
English, fails the build until it is removed from here. A prefix would let the next key added
under it inherit an excuse nobody re-read."""


def _flatten(payload: dict[str, Any], prefix: str = "") -> dict[str, str]:
    flat: dict[str, str] = {}
    for key, value in payload.items():
        path = f"{prefix}{key}"
        if isinstance(value, dict):
            flat.update(_flatten(value, f"{path}."))
        else:
            flat[path] = str(value)
    return flat


def _load(catalogue: str, language: str) -> dict[str, str]:
    return _flatten(json.loads((LOCALES_DIR / f"{catalogue}.{language}.json").read_text(encoding="utf-8")))


@pytest.mark.parametrize("catalogue", CATALOGUES)
def test_every_catalogue_exists_in_every_language(catalogue: str) -> None:
    for language in LANGUAGES:
        if catalogue in ENGLISH_ONLY_CATALOGUES and language == "he":
            continue  # MON-506: no Hebrew card catalogue yet
        assert (LOCALES_DIR / f"{catalogue}.{language}.json").is_file()


@pytest.mark.parametrize("catalogue", CATALOGUES)
def test_languages_define_exactly_the_same_keys(catalogue: str) -> None:
    if catalogue in ENGLISH_ONLY_CATALOGUES:
        pytest.skip(f"{catalogue} has no Hebrew catalogue yet — MON-506")
    english, hebrew = _load(catalogue, "en"), _load(catalogue, "he")
    missing_in_hebrew = sorted(set(english) - set(hebrew) - AWAITING_HEBREW)
    extra_in_hebrew = sorted(set(hebrew) - set(english))
    assert not missing_in_hebrew, f"untranslated: {missing_in_hebrew}"
    assert not extra_in_hebrew, f"orphaned Hebrew keys: {extra_in_hebrew}"


def test_the_awaiting_hebrew_exemption_has_not_rotted() -> None:
    """Every entry in :data:`AWAITING_HEBREW` still names an English key with no Hebrew.

    Without this, the exemption list is a place where a key can hide from the parity check
    forever — either because it was translated and nobody removed it, or because it was renamed
    and the list now silently excuses a key that does not exist.
    """
    english, hebrew = _load("common", "en"), _load("common", "he")
    unknown = sorted(key for key in AWAITING_HEBREW if key not in english)
    assert not unknown, f"AWAITING_HEBREW names keys that are not in common.en.json: {unknown}"
    translated = sorted(key for key in AWAITING_HEBREW if key in hebrew)
    assert not translated, f"these now have Hebrew — remove them from AWAITING_HEBREW: {translated}"


@pytest.mark.parametrize("catalogue", CATALOGUES)
@pytest.mark.parametrize("language", LANGUAGES)
def test_no_empty_strings(catalogue: str, language: str) -> None:
    """An empty value is worse than a missing one: it renders as nothing at all."""
    if catalogue in ENGLISH_ONLY_CATALOGUES and language == "he":
        pytest.skip(f"{catalogue} has no Hebrew catalogue yet — MON-506")
    blanks = sorted(key for key, value in _load(catalogue, language).items() if not value.strip())
    assert not blanks, f"empty values in {catalogue}.{language}: {blanks}"


@pytest.mark.parametrize("catalogue", CATALOGUES)
def test_interpolation_placeholders_match_across_languages(catalogue: str) -> None:
    """`{{amount}}` in English and `{{sum}}` in Hebrew renders a literal brace to a child."""
    if catalogue in ENGLISH_ONLY_CATALOGUES:
        pytest.skip(f"{catalogue} has no Hebrew catalogue yet — MON-506")
    english, hebrew = _load(catalogue, "en"), _load(catalogue, "he")
    mismatched = {
        key: (_placeholders(english[key]), _placeholders(hebrew[key]))
        for key in english.keys() & hebrew.keys()
        if _placeholders(english[key]) != _placeholders(hebrew[key])
    }
    assert not mismatched, f"placeholder mismatch: {mismatched}"


def test_the_classic_board_catalogue_covers_every_tile() -> None:
    """Each of the 40 board tiles needs a name in each language, or the board renders blanks."""
    from kesef_engine.board.loader import load_board

    board = load_board("classic")
    for language in LANGUAGES:
        catalogue = _load("board-classic", language)
        for tile in board.tiles:
            assert tile.name_key in catalogue, f"{tile.name_key} missing from board-classic.{language}.json"


def test_the_israeli_board_has_no_catalogue_yet() -> None:
    """Documents a known gap rather than leaving it to be discovered mid-demo.

    The Israeli edition's city list must come from a verified source, not from a guess —
    see MON-503. When that catalogue lands, delete this test and add `board-israel` to
    CATALOGUES above.
    """
    assert not (LOCALES_DIR / "board-israel.en.json").exists()


def test_the_hebrew_card_catalogue_has_no_catalogue_yet() -> None:
    """Documents a known gap rather than leaving it to be discovered mid-demo.

    31 Chance/Community Chest cards need a native-speaker Hebrew pass, not a plausible
    machine guess — see MON-506. When that catalogue lands, delete this test and remove
    "cards" from ENGLISH_ONLY_CATALOGUES above.
    """
    assert not (LOCALES_DIR / "cards.he.json").exists()


def test_the_card_catalogue_covers_every_card_id() -> None:
    """Every id `decks.py` can deal needs a catalogue entry, or a card lands face blank.

    Imports the ids from the engine rather than hardcoding them, so the catalogue stays
    self-checking as the decks change (MON-206).
    """
    from kesef_engine.decks import CHANCE_CARD_IDS, COMMUNITY_CHEST_CARD_IDS

    catalogue = _load("cards", "en")
    card_ids = set(CHANCE_CARD_IDS) | set(COMMUNITY_CHEST_CARD_IDS)
    missing = sorted(card_id for card_id in card_ids if card_id not in catalogue)
    assert not missing, f"card ids missing from cards.en.json: {missing}"


def _placeholders(value: str) -> set[str]:
    import re

    return set(re.findall(r"\{\{(\w+)\}\}", value))
