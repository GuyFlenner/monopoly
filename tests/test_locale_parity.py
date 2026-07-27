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
    missing_in_hebrew = sorted(set(english) - set(hebrew))
    extra_in_hebrew = sorted(set(hebrew) - set(english))
    assert not missing_in_hebrew, f"untranslated: {missing_in_hebrew}"
    assert not extra_in_hebrew, f"orphaned Hebrew keys: {extra_in_hebrew}"


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
