"""MON-302 — the export the frontend's types are generated from.

The CI `contract` job runs ``python -m kesef_server.openapi``, pipes stdout into
``openapi-typescript`` and diffs the result against the committed
``packages/web/src/api/generated.ts``. Three things therefore have to be true, and each gets
a test: the module runs, stdout is *only* the document, and the document is the same one the
running app serves.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from kesef_server.openapi import document, main

REPO_ROOT = Path(__file__).resolve().parents[3]
GENERATED_TS = REPO_ROOT / "packages" / "web" / "src" / "api" / "generated.ts"

EM_DASH = "—"


def _exported_bytes() -> bytes:
    result = subprocess.run(
        [sys.executable, "-m", "kesef_server.openapi"],
        capture_output=True,
        check=True,
        cwd=REPO_ROOT,
    )
    return result.stdout


def _exported() -> dict[str, Any]:
    """Decoded as UTF-8 explicitly, never through the locale.

    The module writes UTF-8 bytes on purpose. Reading them back with
    ``subprocess.run(text=True)`` decodes through cp1252 on Windows and silently mojibakes
    every em dash in the document, which is the same class of bug that made this a byte-level
    contract in the first place.
    """
    parsed: dict[str, Any] = json.loads(_exported_bytes().decode("utf-8"))
    return parsed


def test_the_module_writes_the_document_to_stdout_and_nothing_else() -> None:
    """A single stray print would break the CI pipe, and the failure would read as drift."""
    exported = _exported()
    assert exported["info"]["title"] == "Kesef Street"
    assert exported["openapi"].startswith("3.")


def test_the_export_is_utf8_bytes_whatever_the_console_encoding_is() -> None:
    """The docstrings this document carries hold em dashes and a shekel sign, and a Windows
    console is cp1252, so ``print`` would die on the document rather than emit it."""
    raw = _exported_bytes()
    decoded = raw.decode("utf-8")  # raises if the bytes are anything else
    assert EM_DASH in decoded, "an all-ASCII document would leave this test proving nothing"
    assert EM_DASH.encode("utf-8") in raw


def test_the_exported_document_is_the_one_the_app_serves(client: TestClient) -> None:
    """Otherwise the committed types describe an API that nobody is running."""
    assert _exported() == client.get("/openapi.json").json()


def test_the_document_helper_returns_the_websocket_route_too() -> None:
    """The hand-declared WS operation has to survive the export, or MON-402 has no contract."""
    paths = document()["paths"]
    assert "/games/{game_id}/ws" in paths
    frame = paths["/games/{game_id}/ws"]["get"]["responses"]["101"]["content"]["application/json"]["schema"]
    assert frame == {"$ref": "#/components/schemas/LoggedEvent"}


def test_the_document_never_offers_fastapis_own_error_shape() -> None:
    """This app rewrites a malformed body into ``{reason_key, params}``, so a declared
    ``HTTPValidationError`` would export a TypeScript type for a response that never comes."""
    assert "HTTPValidationError" not in json.dumps(_exported())


def test_the_generated_typescript_is_committed_and_covers_the_projection() -> None:
    """The CI `contract` job is gated on this file existing; without it the gate is dead.

    Asserting on content, not merely existence: a placeholder file would satisfy the gate and
    the UI would still have no types.
    """
    assert GENERATED_TS.is_file(), "MON-302: packages/web/src/api/generated.ts must be committed"
    source = GENERATED_TS.read_text(encoding="utf-8")
    for name in ("GameView", "GameStateView", "BoardView", "PlayerView", "LoggedEvent", "ErrorResponse"):
        assert f"{name}:" in source, f"{name} missing from generated.ts"
    assert "/games/{game_id}/ws" in source


def test_main_writes_the_document_in_process_as_well_as_out_of_it(capsysbinary: pytest.CaptureFixture[bytes]) -> None:
    """The subprocess tests above prove the entry point; this one runs the same code under
    coverage, so `main` cannot rot behind a green suite."""
    main()
    written = capsysbinary.readouterr().out
    assert written.endswith(b"\n")
    assert json.loads(written.decode("utf-8")) == document()
