"""kesef-server — transports for the kesef-engine rules core.

Run the HTTP one with::

    uv run uvicorn kesef_server.api:app --reload

There is a second transport, :mod:`kesef_server.browser`, which runs the same handlers inside a
browser under Pyodide with no server at all (MON-805).

``app`` is resolved **lazily**. It used to be a plain ``from kesef_server.api import app`` at the
top of this file, which meant importing *anything* in this package imported FastAPI — so
``import kesef_server.browser`` dragged starlette and anyio into a WebAssembly build that never
serves a request, and ``uvicorn[standard]``'s native wheels have no pure-Python equivalent to
install there. ``__getattr__`` (PEP 562) keeps ``from kesef_server import app`` working for anyone
who wants the ASGI application, and costs nothing to anyone who does not.
"""

from typing import Any

__all__ = ["app"]


def __getattr__(name: str) -> Any:
    """Resolve ``kesef_server.app`` on first use. See the module docstring."""
    if name == "app":
        from kesef_server.api import app

        return app
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
