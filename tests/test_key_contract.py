"""ADR-003 §6's cross-boundary contract: every key the engine can emit must resolve.

``test_locale_parity.py`` compares the catalogues to *each other*. That is a different
question, and it is blind to the defect that matters most: a key the engine emits which no
catalogue defines at all. English is the fallback for Hebrew, but nothing is the fallback for
English — so a key missing from both sides is missing *symmetrically*, the parity diff is
empty, and the failure surfaces as a blank panel in front of a player.

That is not hypothetical. Before this test existed, 45 of the 50 ``error.*`` reason keys
``legality.py`` can return had no catalogue entry, and ``TradeBuilder`` renders
``t(verdict.reason_key)`` with no ``i18n.exists`` guard — so a trade refused for almost any
reason blanked the panel that was built to explain the refusal.

The direction of the check is the whole point: it reads the **engine** as the source of truth
and asks the catalogue to keep up, which is what ADR-003 means by "the web catalogues conform
to the engine, not the other way round".
"""

from __future__ import annotations

import json
import re
from enum import StrEnum
from pathlib import Path
from typing import Any

import pytest

REPO = Path(__file__).resolve().parent.parent
LOCALES_DIR = REPO / "packages" / "web" / "src" / "i18n" / "locales"
ENGINE_SRC = REPO / "packages" / "engine" / "src" / "kesef_engine"
SERVER_SRC = REPO / "packages" / "server" / "src" / "kesef_server"

DEVELOPER_SURFACES = frozenset({"cli.py", "__main__.py"})
"""ADR-003 §7's exemption, named exactly.

``cli.py`` and ``goldens/__main__.py`` are invoked by a programmer and print key ids verbatim
rather than resolving them — that is what they are for. Excluded from the scan because a key id
in a developer's terminal is not a translation, and demanding a catalogue entry for one would
teach the opposite of the rule.
"""


def _flatten(payload: dict[str, Any], prefix: str = "") -> dict[str, str]:
    flat: dict[str, str] = {}
    for key, value in payload.items():
        path = f"{prefix}{key}"
        if isinstance(value, dict):
            flat.update(_flatten(value, f"{path}."))
        else:
            flat[path] = str(value)
    return flat


def _catalogue(name: str, language: str = "en") -> dict[str, str]:
    return _flatten(json.loads((LOCALES_DIR / f"{name}.{language}.json").read_text(encoding="utf-8")))


def _python_sources() -> list[Path]:
    """Every shipped module of the engine and the server, developer surfaces excluded."""
    return [
        path
        for root in (ENGINE_SRC, SERVER_SRC)
        for path in sorted(root.rglob("*.py"))
        if path.name not in DEVELOPER_SURFACES
    ]


def _emitted_literals(namespace: str) -> set[str]:
    """Every ``"<namespace>.something"`` string literal the shipped code contains.

    A scan rather than an import because ``IllegalCommandError.reason_key`` and
    ``LegalityVerdict.reason_key`` are typed ``str``: there is no enum to enumerate, so the
    literals in ``legality.py`` and ``rules/*.py`` *are* the contract. A regex over shipped
    source is crude, but it is crude in the safe direction — it over-collects (a key mentioned
    in a docstring counts) and over-collecting only ever demands one extra catalogue entry.
    """
    pattern = re.compile(rf'"({re.escape(namespace)}\.[a-z0-9_.]+)"')
    return {match for path in _python_sources() for match in pattern.findall(path.read_text(encoding="utf-8"))}


# --- The displayed enums -------------------------------------------------------------------


def _displayed_enums() -> tuple[tuple[type[StrEnum], str], ...]:
    from kesef_engine.board.models import ColorGroup, TileKind
    from kesef_engine.primitives import AuctionReason, BotLevel, CashReason, Deck
    from kesef_engine.ruleset import RulesetName

    return (
        # Each pair is (enum, the catalogue namespace the UI concatenates onto). Every one of
        # these is reached by interpolation somewhere in packages/web, so a member without a
        # leaf is a raw English enum value rendered at a child — GAP A5.
        (TileKind, "tile_kind."),  # board/projection.ts
        (ColorGroup, "group."),  # the dossier's set progress
        (Deck, "deck."),  # panels/TradeBuilder.tsx
        (CashReason, "cash_reason."),  # panels/EventLog.tsx
        (AuctionReason, "auction_reason."),  # panels/AuctionPanel.tsx
        (BotLevel, "bot_level."),  # panels/SetupScreen.tsx, via BOT_LEVEL_KEYS
        (RulesetName, "setup."),  # panels/SetupScreen.tsx
    )


def _undisplayed_enums() -> dict[type[StrEnum], str]:
    """Engine enums deliberately absent from the table above, each with its reason.

    Kept as a positive list so :func:`test_every_engine_enum_is_classified` can insist that a
    *new* enum is triaged rather than silently inheriting an exemption nobody re-read.
    """
    from kesef_engine.phases import Phase

    return {
        Phase: (
            "No catalogue sentence interpolates a phase. `error.wrong_phase` carries "
            "`phase=state.phase.value` as a param for a future explain-screen, but its sentence "
            "deliberately does not render it — a raw `awaiting_purchase_decision` inside a Hebrew "
            "sentence is exactly the defect GAP A5 names, and ten phase nouns nobody displays "
            "would be ten fabrications."
        ),
    }


# --- The tests ----------------------------------------------------------------------------


def test_every_rejection_reason_resolves() -> None:
    """The 50 ``error.*`` keys the engine and server can return all have English.

    This is the one that was red. ``TradeBuilder`` and ``GameScreen`` both render
    ``verdict.reason_key`` / ``error.reasonKey`` straight from the wire; the former has no
    ``exists`` guard, so a missing key is a blank panel rather than a bad sentence.
    """
    catalogue = _catalogue("common")
    missing = sorted(key for key in _emitted_literals("error") if key not in catalogue)
    assert not missing, f"the engine can reject with these, and no catalogue defines them: {missing}"


def test_every_rent_note_resolves() -> None:
    """Every rent explanation the engine attaches can be shown.

    ``rent.note.*`` is the mechanism behind "every rent figure can be explained, not merely
    charged". A note the engine emits and the catalogue lacks is a rent the player is simply
    charged.
    """
    catalogue = _catalogue("common")
    missing = sorted(key for key in _emitted_literals("rent.note") if key not in catalogue)
    assert not missing, f"rent notes with no sentence: {missing}"


@pytest.mark.parametrize("language", ("en", "he"))
def test_every_displayed_enum_member_resolves(language: str) -> None:
    """Each member of each interpolated enum has a leaf, in every language.

    Parameterised over language rather than checked in English only: the *reason* these keys
    exist is that an untranslated member interpolates the engine's English identifier into a
    Hebrew sentence, so English-only coverage checks the wrong half.

    No exemption argument any more. This used to subtract ``AWAITING_HEBREW``; MON-501 emptied it,
    so both languages are now held to the same bar with nothing to opt out of.
    """
    catalogue = _catalogue("common", language)
    missing = sorted(
        f"{namespace}{member.value}"
        for enum, namespace in _displayed_enums()
        for member in enum
        if f"{namespace}{member.value}" not in catalogue
    )
    assert not missing, f"enum members with no {language} leaf: {missing}"


def test_every_engine_enum_is_classified() -> None:
    """A new ``StrEnum`` in the engine is either displayed or explicitly not.

    Without this the table above is a snapshot: the next enum to reach the wire would be
    absent from both lists, and absence from the displayed list reads exactly like "checked
    and fine".
    """
    import importlib
    import pkgutil

    import kesef_engine

    found: set[type[StrEnum]] = set()
    for module_info in pkgutil.walk_packages(kesef_engine.__path__, f"{kesef_engine.__name__}."):
        if module_info.name.rsplit(".", 1)[-1] in {"cli", "__main__"}:
            continue
        module = importlib.import_module(module_info.name)
        for value in vars(module).values():
            if isinstance(value, type) and issubclass(value, StrEnum) and value is not StrEnum:
                found.add(value)

    classified = {enum for enum, _ in _displayed_enums()} | set(_undisplayed_enums())
    unclassified = sorted(enum.__name__ for enum in found - classified)
    assert not unclassified, (
        "these engine enums are neither in _displayed_enums() nor _undisplayed_enums() — "
        f"decide which, and write down why: {unclassified}"
    )


def test_every_command_kind_has_a_label() -> None:
    """Every kind the engine accepts has at least one ``action.<kind>`` leaf.

    This is what ADR-003 §6 buys: ``panels/actionCommand.ts`` builds a button label by
    concatenating ``"action." + command.kind``, with no hand-kept map in between — which is why
    ``ActionLabels.ts`` and its 17-entry bridge could be deleted.

    Prefix coverage rather than exact-key coverage, because two kinds legitimately have no base
    label. ``respond_to_trade`` carries an ``accept`` boolean and resolves only to
    ``action.respond_to_trade_accept`` / ``_decline``: accepting and declining are the two
    commands and must not share a button, so a neutral "answer the trade" leaf would be a key
    nothing renders. Which variants exist is a fact about the command's payload, so the exact
    resolution is asserted where the payload types are — ``actionCommand.test.ts``. This side owns
    the question that needs the engine to answer it: *is any kind unlabelled at all.*
    """
    from pydantic import TypeAdapter

    from kesef_engine.commands import Command

    catalogue = _catalogue("common")
    kinds = sorted(_command_kinds(TypeAdapter(Command)))
    assert kinds, "no command kinds discovered — the introspection below has drifted"
    missing = sorted(
        kind
        for kind in kinds
        if not any(key == f"action.{kind}" or key.startswith(f"action.{kind}_") for key in catalogue)
    )
    assert not missing, f"command kinds whose button has no label: {missing}"


def _command_kinds(adapter: Any) -> set[str]:
    """The ``kind`` literal of every member of the ``Command`` union, read off the schema.

    Read from the JSON schema rather than a hand-listed tuple so a new command cannot be added
    to the engine without this test noticing it has no label.
    """
    schema = adapter.json_schema()
    definitions = schema.get("$defs", {})
    kinds: set[str] = set()
    for definition in definitions.values():
        const = definition.get("properties", {}).get("kind", {})
        if "const" in const:
            kinds.add(str(const["const"]))
        kinds.update(str(value) for value in const.get("enum", []))
    return kinds


def test_every_card_id_resolves() -> None:
    """Every card the decks can deal has text. Duplicates the parity test's check on purpose.

    That one reads ``cards.en.json`` because the catalogue owns card *text*; this one belongs
    to the contract suite because the ids come from ``decks.py``. If they ever disagree, the
    disagreement is the finding.
    """
    from kesef_engine.decks import CHANCE_CARD_IDS, COMMUNITY_CHEST_CARD_IDS

    catalogue = _catalogue("cards")
    ids = set(CHANCE_CARD_IDS) | set(COMMUNITY_CHEST_CARD_IDS)
    missing = sorted(card_id for card_id in ids if card_id not in catalogue)
    assert not missing, f"cards that would land face blank: {missing}"


@pytest.mark.parametrize("board_id", ("classic", "israel"))
@pytest.mark.parametrize("language", ("en", "he"))
def test_every_tile_name_resolves(board_id: str, language: str) -> None:
    """Both boards name all 40 squares in both languages."""
    from kesef_engine.board.loader import load_board

    catalogue = _catalogue(f"board-{board_id}", language)
    missing = sorted(tile.name_key for tile in load_board(board_id).tiles if tile.name_key not in catalogue)
    assert not missing, f"unnamed squares on board-{board_id}.{language}: {missing}"


def test_no_catalogue_key_is_camel_case() -> None:
    """``snake_case`` at every level of every namespace (ADR-003 §6).

    The rule is enforced on the *catalogue* and not only on the engine because the catalogue is
    the side that drifted. A camelCase leaf is not a style complaint: ``action.sellHouse`` cannot
    be reached from the command kind ``sell_house``, so it is a key that resolves against
    nothing, which is why ``ActionLabels.ts`` had to exist at all (GAP G-40).
    """
    camel = re.compile(r"[a-z0-9][A-Z]")
    offenders = {
        path.name: sorted(key for key in _flatten(json.loads(path.read_text(encoding="utf-8"))) if camel.search(key))
        for path in sorted(LOCALES_DIR.glob("*.json"))
    }
    offenders = {name: keys for name, keys in offenders.items() if keys}
    assert not offenders, f"camelCase keys must be snake_case per ADR-003 §6: {offenders}"
