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
    from kesef_engine.ruleset import AuctionMinimum, RulesetName

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
        # MON-712: the setup screen offers the floor as a choice, so both members are rendered.
        (AuctionMinimum, "auction_minimum."),  # panels/SetupScreen.tsx, via the house-rule controls
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


@pytest.mark.parametrize("language", ("en", "he"))
def test_every_ruleset_setting_has_a_label(language: str) -> None:
    """MON-417: every flag ``/rulesets`` explains can be named, in both languages.

    This check used to live in the web package as ``SetupScreenRuleset.test.ts``, over a hand-kept
    ``Record<keyof Ruleset, "ruleset.${string}">`` map — and it had to, because the label keys were
    the client's. They are ``Ruleset.label_key``'s now, so the question is cross-boundary and
    belongs here: the engine enumerates the settings, and the catalogue is asked to keep up (ADR-003
    §6). A flag added to ``ruleset.py`` fails this until it has a name a parent can read.
    """
    from kesef_engine.ruleset import Ruleset

    catalogue = _catalogue("common", language)
    fields = Ruleset.setting_fields()
    assert fields, "no settings discovered — the engine's introspection has drifted"
    missing = sorted(field for field in fields if Ruleset.label_key(field) not in catalogue)
    assert not missing, f"rule settings with no {language} label: {missing}"


@pytest.mark.parametrize("board_id", ("classic", "israel"))
def test_a_boards_catalogue_ready_flag_tells_the_truth(board_id: str) -> None:
    """MON-419: the declared flag equals whether the names actually resolve.

    ``Board.catalogue_ready`` is *declared* in the board JSON, because the server cannot read the
    web package's catalogues (see that field). Declared means it can lie, and a board wrongly
    marked ready is precisely the G-46 defect the flag exists to prevent — a picker offering a board
    that paints forty blank squares. This is the only test that can see both sides, so it is where
    the claim is checked rather than trusted.

    Both directions matter. A board marked ready with a missing name would ship the defect; a board
    marked *not* ready whose names are all present would be silently unplayable, which is how the
    Israeli layout would have stayed hidden after MON-503 supplied its catalogue.
    """
    from kesef_engine.board.loader import load_board

    board = load_board(board_id)
    resolves = all(
        tile.name_key in _catalogue(f"board-{board_id}", language) for language in ("en", "he") for tile in board.tiles
    )
    assert board.catalogue_ready is resolves, (
        f"board {board_id} declares catalogue_ready={board.catalogue_ready} "
        f"but its names {'all resolve' if resolves else 'do not all resolve'} — "
        "fix whichever of the two is wrong"
    )


# --- Rejection params: the other half of the contract (MON-723) -----------------------------


UNSPENT_PARAMS: dict[str, str] = {
    "tile": (
        "A board index, not a name. A client uses it to *highlight* the offending square — which is "
        "a better answer than naming one, because the square is on screen. Interpolating it would "
        "print `You don't own 39.`; interpolating a name instead would need the render boundary to "
        "board-scope a `tile.*` key, and `groupLabel` board-scopes only `group.*` today, with a "
        "`common` fallback that `tile.*` has no equivalent of. Filed rather than half-done."
    ),
    "player": (
        "A seat id. A player's name is typed in at the setup screen, so no catalogue can carry it "
        "and no `*_key` can resolve it — naming the player needs the seat list, which is game state "
        "the error boundary deliberately does not hold. `error.bankrupt` and its two siblings say "
        "'that player' and are correct."
    ),
    "phase": (
        "Engine jargon. `error.wrong_phase` carries `phase=state.phase.value` for a future "
        "explain-screen and its sentence deliberately does not render it — a raw "
        "`awaiting_purchase_decision` inside a Hebrew sentence is the GAP A5 defect. The same "
        "decision is recorded against `Phase` in `_undisplayed_enums()`."
    ),
    "status": "An HTTP status. `api.py` attaches it for a bug report, not for a sentence.",
}
"""Params the engine ships that no sentence interpolates, each with the reason it still ships.

The point of a *positive* list: a param that is neither spent nor written down here fails
:func:`test_every_rejection_param_is_spent_or_declared`, so the next one to be added is triaged
rather than inheriting an exemption nobody re-read. That is the whole defect MON-723 was — 19 of
these existed, none of them written down, and the mutation gate found them by noticing that
deleting any one of them changed nothing.
"""

KEY_SUFFIX = "_key"
"""MON-415's convention, mirrored from ``panels/EventLogLines.ts``: a param named ``<name>_key``
carries an i18n key, and the catalogue sentence interpolates the bare ``<name>``."""


def _rejection_params() -> dict[str, set[str]]:
    """``{reason key: every param name any ``_no`` call attaches to it}``, read off the source.

    An AST walk rather than a regex, because a param's *name* is the contract and
    ``f"group.{group.value}"`` as a value would defeat a textual scan.
    """
    import ast

    source = (ENGINE_SRC / "legality.py").read_text(encoding="utf-8")
    found: dict[str, set[str]] = {}
    for node in ast.walk(ast.parse(source)):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "_no"):
            continue
        if not (node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)):
            continue
        found.setdefault(node.args[0].value, set()).update(
            keyword.arg for keyword in node.keywords if keyword.arg is not None
        )
    return found


def _placeholders(sentence: str) -> set[str]:
    """The names a catalogue sentence interpolates, format spec discarded.

    ``{{required, money}}`` is the name ``required`` and MON-720's per-string money format; the
    contract is about the name.
    """
    return {match.split(",")[0].strip() for match in re.findall(r"\{\{([^}]+)\}\}", sentence)}


def _spendable(params: set[str]) -> set[str]:
    """What the catalogue may name: a ``*_key`` param is spent as its bare name."""
    return {param.removesuffix(KEY_SUFFIX) if param.endswith(KEY_SUFFIX) else param for param in params}


@pytest.mark.parametrize("language", ("en", "he"))
def test_every_rejection_placeholder_has_a_param_behind_it(language: str) -> None:
    """A sentence cannot ask for something the engine does not send.

    This is the direction that shows: an unfilled ``{{group}}`` renders literally in front of a
    player, in whichever language forgot it. Checked per language because the two catalogues are
    written separately and a Hebrew sentence can reach for a param the English one does not.
    """
    catalogue = _catalogue("common", language)
    unfilled = {
        key: sorted(_placeholders(catalogue[key]) - _spendable(params))
        for key, params in sorted(_rejection_params().items())
        if key in catalogue and _placeholders(catalogue[key]) - _spendable(params)
    }
    assert not unfilled, f"{language} sentences interpolating params the engine never sends: {unfilled}"


def test_every_rejection_param_is_spent_or_declared() -> None:
    """And the engine cannot send something no sentence spends, unspoken.

    The direction MON-723 was filed for, and the one no test had. 19 of the 35 keyed rejections
    carried a param neither catalogue used — the engine computing context for a sentence that had
    quietly stopped asking for it. `legality.py`'s docstring promised the opposite in as many words.

    A param may still be unspent; it may not be unspent *silently*. Either **its own key's** sentence
    interpolates it in at least one language — English and Hebrew are allowed to differ in how much
    they name, which is a translator's call — or it is in :data:`UNSPENT_PARAMS` with a reason a
    reader can disagree with.

    Per key, and that is load-bearing: the first version of this test asked whether the param name
    appeared *anywhere* in the catalogue, and `{{group}}` does — in `rent.note.full_group_doubled`.
    So it passed with `error.group_incomplete` back to saying "the whole colour set", which is the
    exact defect it was written to catch. It was only found by reverting the copy and watching the
    test stay green.
    """
    catalogues = {language: _catalogue("common", language) for language in ("en", "he")}
    undeclared: dict[str, list[str]] = {}
    for key, params in sorted(_rejection_params().items()):
        spent = {
            placeholder
            for catalogue in catalogues.values()
            if key in catalogue
            for placeholder in _placeholders(catalogue[key])
        }
        unspent = sorted(param for param in _spendable(params) if param not in spent and param not in UNSPENT_PARAMS)
        if unspent:
            undeclared[key] = unspent
    assert not undeclared, (
        "these params are computed, shipped over the wire, and interpolated by nothing — "
        f"spend them in the copy or add them to UNSPENT_PARAMS with the reason: {undeclared}"
    )


def test_no_rejection_param_names_an_enum_value_instead_of_a_key() -> None:
    """MON-415's convention, enforced rather than remembered.

    A param whose value is an engine enum must be sent as ``<name>_key`` carrying
    ``"group.light_blue"``, never as ``<name>`` carrying ``"light_blue"`` — the second puts the
    engine's English identifier inside a Hebrew sentence, which is GAP A5 with extra steps.

    A param in :data:`UNSPENT_PARAMS` is exempt, and the exemption is the convention read correctly
    rather than a hole in it: ``_key`` exists so a value the catalogue *renders* can resolve, and one
    no sentence renders has nothing to resolve. ``phase`` is the case — there are no ``phase.*``
    leaves precisely because inventing ten phase nouns nobody displays would be ten fabrications
    (see :func:`_undisplayed_enums`). Should a sentence ever start naming a phase, this test goes red
    the moment it is spent, because the exemption is keyed to the param being unspent.
    """
    import ast

    source = (ENGINE_SRC / "legality.py").read_text(encoding="utf-8")
    offenders: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "_no"):
            continue
        for keyword in node.keywords:
            if keyword.arg is None or keyword.arg.endswith(KEY_SUFFIX) or keyword.arg in UNSPENT_PARAMS:
                continue
            # `x.value` on an enum member — the shape MON-415 deleted from the rent notes.
            if isinstance(keyword.value, ast.Attribute) and keyword.value.attr == "value":
                offenders.append(f"{ast.unparse(node.args[0])}: {keyword.arg}={ast.unparse(keyword.value)}")
    assert not offenders, (
        "an enum value shipped as a plain param — send a key and name it `<param>_key` "
        f"(MON-415, and see legality.py's docstring): {offenders}"
    )


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
