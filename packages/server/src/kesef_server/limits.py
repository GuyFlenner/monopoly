"""Per-client bounds on the mutating routes (MON-905).

The API is public, unauthenticated, and free to call. Before this module, fifty cheap
``POST /games`` from one address filled ``max_sessions``, and because eviction is an idle sweep at
``session_ttl_minutes`` (four hours), every real player got ``error.server_at_capacity`` until the
sweep caught up. That is a denial of service costing an attacker fifty requests, and the repo had
already watched it happen *by accident* — ``playwright.config.ts`` records the e2e suite nearly
filling the store during MON-707.

Two bounds answer it, and they are deliberately different shapes:

* **A rate**, here: how often one client may ask. :class:`ClientLimiter` is the token bucket.
* **A share**, in :class:`~kesef_server.sessions.SessionStore`: how much of the store one client may
  be holding at once. That one lives with the sessions because only the store can count them.

## Where this runs, and where it deliberately does not

:mod:`kesef_server.api` is the only importer. :mod:`kesef_server.browser` — the same handlers
running inside a Pyodide tab with no server at all (MON-805) — does not import it and must not.
That transport has exactly one caller, the tab it is running in, so a rate limit there would be a
page refusing its own player, and a per-client session cap would be a tab refusing to open a
fourth game for the person who owns the machine. The HTTP middleware and the two routes that stamp
ownership are the only callers, so the browser build gets neither bound by construction — the same
way ``test_the_browser_transport_imports_no_web_framework`` keeps FastAPI off that import graph.

## The clock

Injected, exactly as :class:`~kesef_server.sessions.SessionStore` injects it, and for the same two
reasons that module's docstring gives: the server reads a clock in a countable number of places, and
a test winds it by hand rather than sleeping for a minute to watch a window expire. **Monotonic**, so
a system time change can neither refuse a request that should have passed nor forgive one that
should not.

## The sweep

``{client: deque[timestamp]}``, swept on access the way ``SessionStore._evict_idle`` sweeps. There is
no background task in this server, and a sweep that happens when somebody asks is enough for the
property that matters: a client that stopped calling stops occupying memory. Every tracked client is
visited on every metered request, which is O(clients) — fine at this size, and the alternative is a
timer, which is a second thing that can be wrong.
"""

from __future__ import annotations

import math
import time
from collections import deque
from collections.abc import Callable

WINDOW_SECONDS = 60.0
"""The bucket's window. ``Settings.requests_per_minute`` is spelled per *minute* because a minute is
the unit an operator can reason about — "thirty a minute" is a sentence, "half a request a second"
is arithmetic."""

UNKNOWN_CLIENT = "-"
"""The bucket for a request whose peer address could not be read at all.

One shared bucket rather than one bucket each, and that direction is the safe one: an unidentifiable
caller cannot be given its own allowance, because "unidentifiable" is exactly what an attacker would
arrange if it bought one. In practice this is unreachable over TCP and reachable over an ASGI
transport that omits ``scope["client"]``, which is what a test client is."""


class ClientLimiter:
    """How often one client may ask for something that changes the server's state.

    Not a general-purpose rate limiter, and deliberately so: no storage backend, no decorator, no
    dependency. A dict of deques is the whole mechanism, which is what let this ship without adding
    a package to a server whose handlers also have to run inside Pyodide (see the module docstring).
    """

    def __init__(
        self,
        *,
        requests_per_minute: int,
        trust_forwarded_for: bool,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._requests_per_minute = requests_per_minute
        self._trust_forwarded_for = trust_forwarded_for
        # An instance attribute, not a class-level default, for the reason `SessionStore` gives:
        # a plain function stored on a class binds as a method and swallows the call.
        self._clock = clock
        self._seen: dict[str, deque[float]] = {}

    def identify(self, *, peer: str | None, forwarded_for: str | None) -> str:
        """Which client this is, for both bounds.

        The socket's peer address, unless ``trust_forwarded_for`` says something in front of this
        process rewrote it. Both readings are wrong in the other's world and there is no way to tell
        from inside a request which world this is — it is a deployment fact, so it is a setting.
        Behind Render's edge every request arrives from the edge's own address, so refusing the
        header would put every player on earth in one bucket; in front of nothing the header is
        written by the caller, so trusting it hands that caller an identity generator and both
        bounds become decoration. Off by default (the safe half), and ``render.yaml`` turns it on
        for the one deployment that has a proxy.

        **The nearest hop, not the furthest.** ``X-Forwarded-For`` is a list, and a proxy appends the
        address it received the request *from* — so the last entry is the one the trusted proxy
        itself wrote, and everything to its left is whatever the caller chose to send. The usual
        "the original client is leftmost" reading would mean that even with the setting on, a caller
        sending ``X-Forwarded-For: <anything>`` picks its own bucket per request. This deployment has
        exactly one trusted hop, and taking the rightmost entry is correct for both shapes an edge
        can produce: a header it *replaced* has one entry, and a header it *appended to* has the real
        peer last. A second trusted proxy would make this wrong in the other direction — and would be
        the moment to make the hop count a setting rather than a sentence.
        """
        if self._trust_forwarded_for and forwarded_for is not None:
            hops = [hop.strip() for hop in forwarded_for.split(",") if hop.strip()]
            if hops:
                return hops[-1]
        return peer or UNKNOWN_CLIENT

    def charge(self, client: str) -> int | None:
        """Record one metered request, or say how many seconds until one would be allowed.

        ``None`` means it was recorded and may proceed. An ``int`` is the refusal, and it is a number
        of seconds rather than a bare "no" because the client renders it: "try again in 12 seconds"
        is an instruction a parent can follow, "too many requests" is a complaint. Rounded up and
        floored at one, so the answer is never "try again in 0 seconds" — which would be advice to
        retry immediately into the same refusal.

        A refused request is **not** recorded. Recording it would extend the window every time the
        caller retried, so a client hammering the door could never get back in, and a person who
        double-clicked would be locked out for a minute rather than for the two seconds they had
        earned.
        """
        now = self._clock()
        self._forget_expired(now)
        seen = self._seen.setdefault(client, deque())
        if len(seen) >= self._requests_per_minute:
            return max(1, math.ceil(WINDOW_SECONDS - (now - seen[0])))
        seen.append(now)
        return None

    def _forget_expired(self, now: float) -> None:
        """Drop every timestamp older than the window, and every client left holding none.

        Both halves matter. Dropping the timestamps is what makes the limit a *rate* rather than a
        lifetime quota. Dropping the emptied client is what stops the dict from becoming a permanent
        record of every address that ever called — the same unbounded-growth defect
        ``subscriber_queue_size`` and ``session_ttl_minutes`` exist to prevent, one layer out.

        Materialised with ``list(...)`` because the loop deletes from the dict it is walking, which
        is the same shape as ``SessionStore._evict_idle`` collecting its ids before removing them.
        """
        for client, seen in list(self._seen.items()):
            while seen and now - seen[0] >= WINDOW_SECONDS:
                seen.popleft()
            if not seen:
                del self._seen[client]

    def __len__(self) -> int:
        """How many clients are currently remembered. Mirrors ``SessionStore.__len__`` — it exists so
        a test can assert that the sweep actually reclaims, rather than assert only that a request
        was allowed again."""
        return len(self._seen)
