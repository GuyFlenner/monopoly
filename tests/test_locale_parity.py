"""Repo-level checks that do not belong to a single package.

Locale parity is the one that earns its keep: a key present in English and missing in
Hebrew is invisible in development (English is the fallback) and shows up as untranslated
text in front of a Hebrew-speaking child. A JSON diff catches it in a second.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import pytest

LOCALES_DIR = Path(__file__).resolve().parent.parent / "packages" / "web" / "src" / "i18n" / "locales"
CATALOGUES = ("common", "board-classic", "board-israel", "cards")
LANGUAGES = ("en", "he")

# Empty, and that is MON-506 closed.
#
# "cards" was the last entry. It was held back on the ground that 31 cards of Hebrew need a
# native-speaker pass rather than a machine-plausible guess — the reasoning MON-503 applies to the
# Israeli board, where it was right, because those city names are *external facts* that a
# translation cannot recover. The card texts turned out not to be that: they are **this project's
# own English prose**, written for MON-206 and deliberately not any published deck's wording, so
# rendering them in Hebrew is a translation of our own sentences and not an invention of game data.
#
# What made it safe to write was the cross-check available: every text has a machine-readable
# effect beside it in `decks.py`, so "pay 25 for each house" is checkable against
# `Repairs(per_house=25, per_hotel=100)` rather than believed. The square names come from
# `board-classic.he.json` verbatim, so a card names the square the way the board does.
#
# The tuple stays so a future catalogue can be exempted while it is being written, and so every
# skip below keeps naming the reason it exists.
ENGLISH_ONLY_CATALOGUES: tuple[str, ...] = ()

# There is no `AWAITING_HEBREW` any more, and that is the point of this comment.
#
# It began as nine frozensets covering roughly 270 keys, one per item that had added English-only
# text, each with a written reason. MON-501 emptied it in three passes, and the reasons are worth
# keeping because each was believed at the time and each turned out to be narrower than it looked:
#
# 1. **225 keys** were labels, nouns and impersonal sentences with nothing to agree with. Withheld on
#    the general ground that "Hebrew needs a native speaker", which is true of card flavour text and
#    board names and not true of "Close" or "Auctions".
# 2. **Second person is not a gender problem in unpointed Hebrew.** Everything carrying "you"/"your"
#    was exempt, but `שלך` and `שלכם` read as either gender once niqqud is off (owner decision 4).
# 3. **The last 45 named a person and hung a verb off them** — the real G-42 case, and the only one.
#    They are gender-free now, using the technique Hebrew UI localization settled on: put the noun in
#    the head position (`תשלום`, `מעבר`, `קנייה`) so nothing conjugates, and let the person be the
#    object of a preposition. Where a verb was worth keeping, its subject is a thing whose gender is
#    fixed — money is plural (`נכנסו`), an offer is feminine (`נדחתה`).
#
# The consequence is architectural, not just editorial: **no component needs to know a player's
# gender**, because there is no form to select between. `grammatical_gender` still reaches the wire
# and is still the right field to have — it is what a future pass would use to make the two known
# cases read more naturally — but nothing is blocked on it and no plumbing carries it today.
#
# `cards` was the last holdout and landed with MON-506, on the reasoning above the tuple.


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
    missing_in_hebrew = sorted(english_bases - hebrew_bases)
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


HEBREW_LETTER = r"֐-׿"
"""The Hebrew block. Written as an escape range because a literal one reorders in a diff."""


@pytest.mark.parametrize("catalogue", CATALOGUES)
def test_no_hebrew_word_is_glued_to_an_interpolation(catalogue: str) -> None:
    """Morphology never crosses an interpolation boundary (GAP G-F8).

    Hebrew attaches the definite article, prepositions and possessives as *prefixes*, so it is
    natural to write ``ל{{owner}}`` — and wrong, because the value arriving is a proper noun that
    already carries its own article: the result is ``להבנק`` where Hebrew wants ``לבנק``. The same
    defect had the catalogue gluing an article and a feminine suffix onto a translated colour name
    (``ה{{group}}ה``), which is wrong for three of the eight groups.

    The rule is mechanical: **no Hebrew letter immediately beside a brace.** The fix is never to
    inflect more cleverly, it is to add a field per form, or to restructure so the value is not the
    object of a prefix — a leading ``{{tile}}:`` or an apposition after a dash.

    A hyphenated prefix (``ו-{{second}}``, ``כ-{{minutes}}``, ``ב-{{amount}}``) passes, and should:
    the hyphen is the conventional Hebrew spelling before a numeral or a Latin token, and it does not
    change with the value — which is what makes it not this defect.
    """
    if catalogue in ENGLISH_ONLY_CATALOGUES:
        pytest.skip(f"{catalogue} has no Hebrew catalogue yet — MON-506")
    glued = re.compile(rf"[{HEBREW_LETTER}]\{{\{{|\}}\}}[{HEBREW_LETTER}]")
    offenders = {key: value for key, value in _load(catalogue, "he").items() if glued.search(value)}
    assert not offenders, (
        "Hebrew morphology is glued to a placeholder — add a field per form, or restructure so the "
        f"value is not the object of a prefix: {offenders}"
    )


@pytest.mark.parametrize("catalogue", CATALOGUES)
def test_the_hebrew_catalogue_is_not_a_copy_of_the_english_one(catalogue: str) -> None:
    """A Hebrew value identical to its English one is an untranslated string hiding from the diff.

    The parity check above only asks whether a *key* exists. Copying the English file to
    ``common.he.json`` would satisfy it completely while shipping an English game under a Hebrew
    flag — and that is not a hypothetical failure mode, it is the shortest path to a green build.

    Identical is allowed only where the string has **no letters of its own**: ``+{{hidden}}`` and
    ``{{name}}, {{kind}}{{owner}}`` are punctuation and placeholders, so there is nothing in them to
    translate and a difference would be the surprising outcome. A rule rather than an allowlist,
    because an allowlist is where the next untranslated string goes to hide.
    """
    if catalogue in ENGLISH_ONLY_CATALOGUES:
        pytest.skip(f"{catalogue} has no Hebrew catalogue yet — MON-506")
    english, hebrew = _load(catalogue, "en"), _load(catalogue, "he")
    has_letters = re.compile(r"[A-Za-z]")
    untranslated = {
        key: english[key]
        for key in english.keys() & hebrew.keys()
        if english[key] == hebrew[key] and has_letters.search(re.sub(r"\{\{\w+\}\}", "", english[key]))
    }
    assert not untranslated, f"identical to English, so not translated: {untranslated}"


@pytest.mark.parametrize("board_id", ("classic", "israel"))
def test_the_board_catalogue_covers_every_tile(board_id: str) -> None:
    """Each of the 40 board tiles needs a name in each language, or the board renders blanks."""
    from kesef_engine.board.loader import load_board

    board = load_board(board_id)
    for language in LANGUAGES:
        catalogue = _load(f"board-{board_id}", language)
        for tile in board.tiles:
            assert tile.name_key in catalogue, f"{tile.name_key} missing from board-{board_id}.{language}.json"


def test_the_hebrew_card_catalogue_says_what_each_card_actually_does() -> None:
    """MON-506. The replacement for the tripwire that asserted this file did *not* exist.

    A translated card is worse than a missing one if it states the wrong figure: a player who is
    told to pay 20 and charged 25 has been lied to by the game, and the log will not agree with the
    card they just read. So the amounts are not proof-read, they are **checked against the engine**
    — every figure in `decks.py`'s effect table must appear in the Hebrew sentence for that card,
    exactly as it must in the English one.

    It cannot check that the Hebrew is *good*, and does not pretend to. It can check that it is not
    quietly wrong about money, which is the failure that would matter.
    """
    from kesef_engine.decks import CARD_EFFECTS

    hebrew = _load("cards", "he")
    english = _load("cards", "en")
    assert set(hebrew) == set(english), "the two card catalogues describe different decks"

    for card_id, effects in CARD_EFFECTS.items():
        text = hebrew[card_id]
        for effect in effects:
            for field in ("amount", "per_house", "per_hotel", "spaces"):
                figure = getattr(effect, field, None)
                if figure is None:
                    continue
                # `spaces` is spelled in words on the card ("three squares back"), which is the one
                # figure a player never has to add up — so the digit is not required for it.
                if field == "spaces":
                    continue
                assert str(figure) in text, (
                    f"{card_id}: the Hebrew text does not state {field}={figure} "
                    f"that {type(effect).__name__} will actually apply — {text}"
                )


def test_every_card_that_names_a_figure_names_its_currency() -> None:
    """MON-720. The two catalogues have to agree about money, not just about amounts.

    This is the defect the owner reported, in its original form: eighteen English cards said ``$50``
    because a card is prose somebody wrote, their Hebrew twins said ``50``, and every figure the UI
    computed said ``50`` in both. So a child read "pay $50" on a card and watched a bare 50 leave their
    pile — the game contradicting itself about its own currency.

    The decision was ``$50`` in English and ``50 ₪`` in Hebrew (`web/src/i18n/money.ts`). Interpolated
    figures get it from the formatter; a card's figures are *in the sentence*, so they get it here, and
    nothing but a test keeps the eighteenth card honest when somebody adds a nineteenth.
    """
    symbols = {"en": "$", "he": "₪"}
    for locale, symbol in symbols.items():
        catalogue = _load("cards", locale)
        silent = sorted(card_id for card_id, text in catalogue.items() if re.search(r"\d", text) and symbol not in text)
        assert not silent, f"{locale} cards state a figure without naming the currency ({symbol}): {silent}"


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
    """The parameter *names* a string interpolates, ignoring any format spec.

    ``{{amount, money}}`` names ``amount``. The spec was added by MON-720 so a sentence can say that
    its figure is currency (``$50`` / ``50 ₪``), and the pattern has to see through it: matching only
    ``{{name}}`` would have quietly stopped checking all thirty-two money placeholders in the product —
    a test that still passes and no longer looks, which is the failure mode this file exists to avoid.
    """
    import re

    return set(re.findall(r"\{\{\s*(\w+)\s*(?:,[^}]*)?\}\}", value))
