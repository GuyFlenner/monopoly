"""Repo-level checks that do not belong to a single package.

Locale parity is the one that earns its keep: a key present in English and missing in
Hebrew is invisible in development (English is the fallback) and shows up as untranslated
text in front of a Hebrew-speaking child. A JSON diff catches it in a second.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import pytest

LOCALES_DIR = Path(__file__).resolve().parent.parent / "packages" / "web" / "src" / "i18n" / "locales"
CATALOGUES = ("common", "board-classic", "board-israel", "cards")
LANGUAGES = ("en", "he")

# "cards" ships English-only for now: 31 cards of Hebrew need a native-speaker pass rather
# than a machine-plausible guess (MON-506), the same reasoning MON-503 applies to the
# Israeli board. Every parity check that compares English against Hebrew is skipped for a
# catalogue listed here; the tripwire test below still asserts the Hebrew file is absent so
# the exemption cannot be quietly forgotten once MON-506 lands.
ENGLISH_ONLY_CATALOGUES = ("cards",)

AWAITING_HEBREW = frozenset(
    {
        # Spoken by ``<Announcer>`` (MON-411).
        "a11y.cash_gained",
        "a11y.cash_paid",
        "a11y.moved",
        "a11y.passed_go",
        "a11y.rent_charged",
        "a11y.turn",
        # The written history (MON-407). The bulk of it, because every line is a sentence about somebody.
        "log.auction_ended",
        "log.bid_placed",
        "log.bidder_withdrew",
        "log.card_drawn",
        "log.cash_gained",
        "log.cash_paid",
        "log.debt_incurred",
        "log.debt_settled",
        "log.dice_rolled_jail",
        "log.dice_rolled_move",
        "log.dice_rolled_rent",
        "log.game_ended",
        "log.left_jail_card",
        "log.left_jail_doubles",
        "log.left_jail_fine",
        "log.left_jail_time_served",
        "log.player_bankrupted",
        "log.property_acquired_auction",
        "log.property_acquired_bankruptcy",
        "log.property_acquired_purchase",
        "log.property_acquired_trade",
        "log.rent_charged",
        "log.sent_to_jail_card",
        "log.sent_to_jail_three_doubles",
        "log.sent_to_jail_tile",
        "log.token_moved",
        "log.token_moved_back",
        "log.token_moved_passed_go",
        "log.trade_cancelled_proposer",
        "log.trade_cancelled_system",
        "log.trade_declined",
        "log.trade_executed",
        "log.trade_proposed",
        "log.turn_started",
        # The auction panel (MON-409), where a bid is attributed to a bidder.
        "auction.standing_bid",
        "auction.your_turn_to_bid",
        # The trade builder (MON-410): ``{{name}} gives`` is a verb agreeing with a named subject.
        "trade.between",
        "trade.side_cash",
        "trade.side_gives",
    }
)
"""The 45 keys whose Hebrew is the owner's, and the only reason left for an exemption.

Every one of these **names a person and hangs a verb or a possessive off them**, and Hebrew
conjugates to the subject's gender (GAP G-42). ``רותי עבר`` is wrong to every Hebrew speaker, and
wrong in a children's game is worse than absent. ``grammatical_gender`` exists on ``SeatConfig`` and
``PlayerState`` and reaches the wire (owner decision 5) precisely so i18next can select between a
masculine and a feminine form once the owner supplies the pairs — see
``docs/MON-501_HEBREW_WORKSHEET.md``.

This used to be nine sets covering roughly 270 keys, one per item that added English-only text. Eight
of them are gone: MON-501 translated 225 of those keys, and the reason the other sets gave for
withholding turned out not to survive examination. Two examples worth keeping, because the same
mistake is easy to make again:

* **Second person is not a gender problem in unpointed Hebrew.** ``setup.seed_hint``,
  ``error.not_owner`` and ``confirm.consequence.*`` were withheld for carrying "you"/"your", but
  ``שלך`` and ``שלכם`` read as either gender once niqqud is off (owner decision 4), and an impersonal
  construction — the style ``error.group_incomplete`` already used — has no verb to agree at all.
* **A reason interpolated into a sentence should be a noun, not a verb.** The ``cash_reason.*`` and
  ``auction_reason.*`` labels were withheld because a past-tense English verb ("won an auction")
  would need to agree with whoever won. Rendered as Hebrew noun phrases (``זכייה במכירה פומבית``)
  there is nothing to agree with, and they read better in the carrying sentence.

A per-key list rather than a ``log.*`` prefix exemption, and a tripwire test below, so the exemption
cannot outlive its reason: a key that gains Hebrew, or that stops existing in English, fails the
build until it is removed from here. A prefix would let the next key added under it inherit an excuse
nobody re-read."""


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


CLDR_PLURAL_CATEGORIES = frozenset({"zero", "one", "two", "few", "many", "other"})
"""The six plural categories CLDR defines. Which of them a *language* uses is not this file's
business — see the note on :func:`_plural_base`."""


def _plural_base(key: str) -> str:
    """``label.squares_one`` -> ``label.squares``; anything else unchanged.

    Why parity is checked on bases rather than on whole keys: **the languages genuinely do not have
    the same plural keys, and must not.** English needs `one`/`other`; Hebrew has a dual, so it needs
    `one`/`two`/`other`. Comparing key sets directly would report ``label.squares_two`` as an
    orphaned Hebrew key and force the catalogue to be wrong to keep the test green.

    So this test asks the question that *is* language-independent — does each language say something
    about this base at all — and the question it deliberately does not ask is whether the right
    categories are present. That needs `Intl.PluralRules`, the same resolver i18next uses at runtime,
    so it is asserted in `packages/web/src/i18n/plurals.test.ts` rather than guessed from a
    hardcoded table here. A table in this file would be a second opinion about CLDR, and CLDR is the
    one that moves: Hebrew's `many` category was removed from it, which is why the older note in this
    file calling for ``_many`` keys was wrong.

    Only a suffix that is an actual category is stripped, so ``a11y.tile_one_house`` and
    ``action.sell_house_hotel`` are left alone.
    """
    base, separator, suffix = key.rpartition("_")
    return base if separator and suffix in CLDR_PLURAL_CATEGORIES else key


def _plural_bases(keys: Iterable[str]) -> set[str]:
    return {_plural_base(key) for key in keys}


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
    # Compared as plural bases: the two languages have different plural categories by design, so
    # `label.squares_two` is a correct Hebrew key with no English counterpart. See `_plural_base`.
    english_bases = _plural_bases(english)
    hebrew_bases = _plural_bases(hebrew)
    exempt = _plural_bases(AWAITING_HEBREW)
    missing_in_hebrew = sorted(english_bases - hebrew_bases - exempt)
    extra_in_hebrew = sorted(hebrew_bases - english_bases)
    assert not missing_in_hebrew, f"untranslated: {missing_in_hebrew}"
    assert not extra_in_hebrew, f"orphaned Hebrew keys: {extra_in_hebrew}"


# There is deliberately no test here for "every plural suffix is a real CLDR category".
#
# The first attempt flagged `setup.kids_changes`, `action.sell_house_hotel` and five others on a
# clean tree, because any key `X_suffix` sitting beside a key `X` looks identical to a plural family
# from this side — `setup.kids` exists as a ruleset name, so `setup.kids_changes` reads as a plural
# form of it. A check that cannot tell a typo from a naming coincidence is not worth its output.
#
# The risk it was aiming at is covered where the answer is knowable: a misspelled `label.squares_ohter`
# leaves the required `other` category missing, and `packages/web/src/i18n/plurals.test.ts` asks
# `Intl.PluralRules` — the resolver i18next actually uses — which categories each language requires.


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
def test_no_translation_names_a_placeholder_nobody_supplies(catalogue: str) -> None:
    """A translation may use fewer placeholders than English, never a different one.

    The defect is a Hebrew string naming a parameter the call site does not pass: ``{{amount}}`` in
    English and ``{{sum}}`` in Hebrew renders a literal ``{{sum}}`` to a child, because the params
    are supplied once, by shared code, and English is the reference for what is in them.

    Subset rather than equality, which is a deliberate loosening of what this test used to assert.
    Requiring the same set forbade correct translations: English ``label.squares_one`` is
    "{{count}} square" and reads "1 square", where Hebrew says ``משבצת אחת`` — "one square", with the
    numeral spelled into the word, which is how Hebrew counts one of something. Dropping a
    placeholder can only ever fail to show a value; naming an unsupplied one puts braces on screen.
    That asymmetry is the whole reason this direction is the one worth enforcing.
    """
    if catalogue in ENGLISH_ONLY_CATALOGUES:
        pytest.skip(f"{catalogue} has no Hebrew catalogue yet — MON-506")
    english, hebrew = _load(catalogue, "en"), _load(catalogue, "he")
    unsupplied = {
        key: sorted(_placeholders(hebrew[key]) - _placeholders(english[key]))
        for key in english.keys() & hebrew.keys()
        if _placeholders(hebrew[key]) - _placeholders(english[key])
    }
    assert not unsupplied, f"Hebrew names placeholders nothing passes: {unsupplied}"


@pytest.mark.parametrize("board_id", ("classic", "israel"))
def test_the_board_catalogue_covers_every_tile(board_id: str) -> None:
    """Each of the 40 board tiles needs a name in each language, or the board renders blanks."""
    from kesef_engine.board.loader import load_board

    board = load_board(board_id)
    for language in LANGUAGES:
        catalogue = _load(f"board-{board_id}", language)
        for tile in board.tiles:
            assert tile.name_key in catalogue, f"{tile.name_key} missing from board-{board_id}.{language}.json"


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
