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
CATALOGUES = ("common", "board-classic")
LANGUAGES = ("en", "he")


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
        assert (LOCALES_DIR / f"{catalogue}.{language}.json").is_file()


@pytest.mark.parametrize("catalogue", CATALOGUES)
def test_languages_define_exactly_the_same_keys(catalogue: str) -> None:
    english, hebrew = _load(catalogue, "en"), _load(catalogue, "he")
    missing_in_hebrew = sorted(set(english) - set(hebrew))
    extra_in_hebrew = sorted(set(hebrew) - set(english))
    assert not missing_in_hebrew, f"untranslated: {missing_in_hebrew}"
    assert not extra_in_hebrew, f"orphaned Hebrew keys: {extra_in_hebrew}"


@pytest.mark.parametrize("catalogue", CATALOGUES)
@pytest.mark.parametrize("language", LANGUAGES)
def test_no_empty_strings(catalogue: str, language: str) -> None:
    """An empty value is worse than a missing one: it renders as nothing at all."""
    blanks = sorted(key for key, value in _load(catalogue, language).items() if not value.strip())
    assert not blanks, f"empty values in {catalogue}.{language}: {blanks}"


@pytest.mark.parametrize("catalogue", CATALOGUES)
def test_interpolation_placeholders_match_across_languages(catalogue: str) -> None:
    """`{{amount}}` in English and `{{sum}}` in Hebrew renders a literal brace to a child."""
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


def _placeholders(value: str) -> set[str]:
    import re

    return set(re.findall(r"\{\{(\w+)\}\}", value))
