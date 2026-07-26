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


settings = Settings()
