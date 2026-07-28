"""Server settings. Environment-driven, no secrets in source."""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="KESEF_", env_file=".env", extra="ignore")

    log_level: str = "INFO"
    cors_origins: tuple[str, ...] = ("http://localhost:5173",)
    """The Vite dev server. Production serves the built assets from the same origin."""

    max_sessions: int = 50
    """In-memory games are capped so a stray load test cannot exhaust the process."""

    session_ttl_minutes: int = 240
    """How long a game may sit untouched before its slot is reclaimed. Hotseat games are long
    and a turn can take a while, so this is generous.

    Enforced by ``SessionStore._evict_idle``, swept on access. Until MON-303's review this
    setting was declared, documented as if it did something, and referenced nowhere — which
    left ``max_sessions`` with no recovery path but a restart. A setting that does nothing is
    worse than a missing one, because the docstring is then a lie somebody will believe."""

    max_subscribers_per_game: int = Field(default=8, ge=1)
    """How many WebSocket listeners one game will carry. Hotseat play needs one or two — six
    players share a screen — so this is already generous. Uncapped, an unauthenticated client
    could register sixty sockets against one game and the subscriber list grew without bound
    (MON-303 security review)."""

    subscriber_queue_size: int = Field(default=256, ge=1)
    """How many events one listener may fall behind by. A command produces a handful of events,
    so this is ~25 commands of slack. The bound is the point: an unbounded queue turns a client
    that stops reading into unbounded process memory, and the overflow closes that socket rather
    than growing for it.

    ``ge=1`` is load-bearing rather than tidy: ``asyncio.Queue(maxsize=0)`` is *unbounded*, so a
    zero here would silently restore the exact defect this setting exists to fix."""

    max_save_bytes: int = 512_000
    """Ceiling on an uploaded save file. A real save is ~30 KB, so this is ample; the point
    is that ``POST /games/load`` is the one route whose body is not a small fixed shape,
    and an unbounded body read is a denial-of-service invitation (MON-100 security review)."""


settings = Settings()
