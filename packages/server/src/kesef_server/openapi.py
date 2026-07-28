"""Export the OpenAPI document (MON-302).

    uv run python -m kesef_server.openapi > openapi.json

This is the seam between the two languages. The frontend does not hand-write API types; CI
runs this module, pipes it through ``openapi-typescript`` and diffs the result against the
committed ``packages/web/src/api/generated.ts``. A field renamed in
:mod:`kesef_server.schemas` therefore becomes a *TypeScript compile error* rather than an
``undefined`` in front of a player.

Because the document is piped, **stdout carries the document and nothing else**. Anything
this module printed alongside it would land inside the JSON the generator parses, and the
failure would read as contract drift rather than as a stray print.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from kesef_server.api import app


def document() -> dict[str, Any]:
    """The document the running app serves, including the hand-declared WebSocket route."""
    schema: dict[str, Any] = app.openapi()
    return schema


def main() -> None:
    """Write the document as UTF-8 bytes, whatever the console thinks it is.

    Deliberately ``stdout.buffer`` and not ``print``: a docstring in the engine contains a
    shekel sign, and a Windows console defaults to cp1252, so ``print`` dies on it. Encoding
    here rather than trusting the terminal is also what makes the export byte-identical on
    Windows and on the Linux CI runner — the `contract` job diffs those bytes.
    """
    payload = json.dumps(document(), indent=2, sort_keys=False, ensure_ascii=False)
    sys.stdout.buffer.write(payload.encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
