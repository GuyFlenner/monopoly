"""kesef-server — FastAPI transport for the kesef-engine rules core.

Run it with::

    uv run uvicorn kesef_server.api:app --reload
"""

from kesef_server.api import app

__all__ = ["app"]
