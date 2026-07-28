"""Server settings. Environment-driven, no secrets in source."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="KESEF_", env_file=".env", extra="ignore")

    log_level: str = "INFO"
    cors_origins: tuple[str, ...] = ("http://localhost:5173",)
    """The Vite dev server. Production serves the built assets from the same origin."""

    max_sessions: int = 50
    """In-memory games are capped so a stray load test cannot exhaust the process."""

    session_ttl_minutes: int = 240
    """Idle games are evicted. Hotseat games are long, so this is generous."""

    max_save_bytes: int = 512_000
    """Ceiling on an uploaded save file. A real save is ~30 KB, so this is ample; the point
    is that ``POST /games/load`` is the one route whose body is not a small fixed shape,
    and an unbounded body read is a denial-of-service invitation (MON-100 security review)."""


settings = Settings()
