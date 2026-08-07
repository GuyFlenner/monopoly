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

    bot_think_seconds: float = Field(default=0.6, ge=0.0, le=10.0)
    """How long a bot pauses before each of its moves (MON-304).

    A bot's turn has to be *watchable*: applied at machine speed, six bot moves arrive as one block
    and a child sees the board jump rather than a player taking a turn. The pause yields the event
    loop, so the WebSocket queues drain between moves and the turn unfolds.

    Zero disables it, which is what the tests use — they assert on what the bot did, not on how long
    it took, and a suite that slept would be paying 0.6 s per bot move to test nothing.
    """

    bot_max_steps_per_call: int = Field(default=200, ge=1)
    """A hard bound on how many commands one bot-driving call will apply.

    Not decoration. The easy bot picks uniformly among its legal moves, and on a developed board that
    includes mortgage, unmortgage, build and sell — so it can legitimately churn before it happens to
    pick ``end_turn``. That terminates, but a request handler needs a bound rather than a proof: an
    engine change that made two commands mutually re-enabling would turn the loop into a hang, and a
    hang is worse than a bot that stops and logs why. Per call, so the next command resumes.
    """

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

    requests_per_minute: int = Field(default=30, ge=1)
    """How many *mutating* requests one client may make in a minute — starting a game, loading a
    save, ending one (MON-905).

    Generous on purpose, and the number is a family evening rather than a benchmark: a parent
    setting a table up might create a game, delete it because somebody wanted the other board, load
    last week's save, and start again. That is a handful of deliberate acts over several minutes,
    nowhere near thirty. Low enough to matter, too — ``max_sessions`` is 50, so filling the store
    from one address now costs a script two sustained minutes rather than one second, which is long
    enough for the idle sweep and for a person to notice.

    **Reading and playing are not metered**, and that is the half of the scope worth writing down.
    ``GET /games/{id}`` is what every reconnect polls, and ``POST /games/{id}/commands`` is a dice
    roll — a bound that could refuse a turn would be a rule about how fast a six-year-old may play,
    which is not the transport's business and would be rule logic outside the engine besides.

    ``ge=1`` rather than ``ge=0``: a zero here would refuse *every* mutating request, so the setting
    that exists to keep the table open would be the thing that closed it."""

    max_sessions_per_client: int = Field(default=5, ge=1)
    """How many live games one client may be holding at once (MON-905).

    ``max_sessions`` bounds the *process*; this bounds one caller's share of it, and it is the half
    that was missing. Checked before the global cap, so one client cannot reach ``max_sessions`` at
    all — a 429 telling that client it already has five games is a true and actionable answer,
    where the 503 everybody else used to get named a condition they did not cause.

    Five because a household genuinely can have two or three going at once — one per room, one
    abandoned mid-setup — and because ten clients at their cap is still only a fifth of
    ``max_sessions``. A client is identified by address (see :mod:`kesef_server.limits`), which is a
    *bound* and not an identity: everybody behind one router shares a number. That is the reason
    this is five and not two."""

    trust_forwarded_for: bool = False
    """Whether ``X-Forwarded-For`` may name the client instead of the socket's peer (MON-905).

    Off by default, and that default is the security property. With nothing in front of this process
    the header is written by whoever called, so trusting it would let one script mint a fresh
    identity per request and walk through both bounds above as if they were not there. Behind
    Render's edge the opposite is true: every request arrives from the edge's address, so *without*
    it every player in the world shares one bucket.

    Which of those two a running process is in cannot be detected from inside a request — it is a
    deployment fact — so it is a setting rather than a heuristic. ``render.yaml`` sets it; a local
    ``uvicorn`` and the test suite leave it off. See :meth:`kesef_server.limits.ClientLimiter.identify`
    for which hop of the header is read, and why it is not the leftmost one."""


settings = Settings()
