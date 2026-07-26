# Project Brief — Kesef Street

What was asked for, what was decided in response, and what was deliberately left out.
The design itself is in `docs/superpowers/specs/2026-07-25-kesef-street-design.md`.

---

## The request

> Build a Monopoly game for children. Universal rules. English by default, plus a Hebrew
> version with the streets and cities from the Hebrew edition. 2–6 players, human vs machine
> or human vs human up to six. Use game libraries so the UI looks good; Python, React/Vite or
> whatever is best — I want to learn from it too. Bootstrap the repo from `claude-stream`'s
> conventions. Public GitHub repo, local git until then. Best practices throughout: product,
> UX, dev, architecture. Some flexibility — show a player's properties, and be able to show
> two players' properties side by side.

---

## Decisions taken, and why

### The stack

**Pure Python rules engine → thin FastAPI server → React web UI** (ADR-001).

Considered and rejected: a Pygame desktop app (one language and one toolchain, but Hebrew RTL
must be hand-rolled and every panel is manual rectangle arithmetic), and building both a
Pygame and a web front end (proves the engine is UI-agnostic, at 1.6× the UI work plus a
permanent parity tax). A **text-mode driver** makes the same point for almost nothing, and it
comes with a second benefit: the rules must be provably correct before any pixel exists.

### The engine's shape

**A reducer with the RNG inside the state** (ADR-002). `apply(state, command) -> (state, events)`.

This is the decision most worth understanding, because five features fall out of it rather
than being built: save/load, replay, undo, bot lookahead, and a wire protocol for networked
play if we ever want it. The state is one frozen, fully serializable value with no hidden state
anywhere — no globals, no clock, no `random` module.

### Two boards, two languages, independently

**Boards are data; names are i18n keys; board choice and language are separate** (ADR-003).

The Hebrew edition traditionally uses Israeli cities, so "add Hebrew" is a second board as well
as a translation. Keeping names as keys means the engine never contains English, and keeping
the two choices independent means the Israeli board can be played in English and the classic
board in Hebrew. Both boards share identical economics slot for slot, enforced by a test, so
one ruleset stays valid for both.

### Children *and* the universal rules

**One ruleset implementation; Kids Mode is feature flags** (ADR-004).

The brief asked for both, and they pull against each other — auctions and mortgages are hard
for a six-year-old, and a full game runs long. So the default is the complete universal rules,
and Kids Mode switches features off: no auctions, no mortgages, simplified trades, hints on, a
target duration. Two implementations were never on the table; they diverge, and a player
discovers the divergence mid-game.

### The UI knows no rules

**`legal_commands` is the contract** (ADR-005). The engine returns every legal move with
concrete parameters, and the UI renders those as buttons. This removes the bug family where
the button is enabled but the move is rejected, and it means bots and humans are offered
exactly the same options.

### Multiplayer scope

**Local hotseat for v1** (ADR-006). 2–6 seats on one screen, any seat a bot. That satisfies
every case in the brief with no lobby, no accounts, no reconnection logic. Networked play is
deferred but not designed out — the engine is already command-in/event-out and the server is
already authoritative.

### The flexibility asks

- **`PlayerDossier`** — one player's holdings grouped by colour set, with set completion,
  houses, hotels and mortgage flags.
- **`CompareTray`** — pins 1–3 dossiers side by side. Two was the ask; the component takes a
  list, so three cost nothing.
- Any player's dossier is viewable at any time. Under the universal rules holdings are public,
  so there is nothing to hide.

### The name

The genre's best-known product is a live Hasbro trademark, and this repo is **public**. The
project therefore carries its own name — **Kesef Street** / **רחוב הכסף**, "Money Street",
which happens to work in both languages — its own artwork, and its own board naming, and
describes itself as an implementation of the widely played *ruleset*. This was raised with the
owner before any code was written and the design proceeded on that basis. The local folder
stays `C:\code1\monopoly`; only the published identity differs.

---

## Migrated from `claude-stream`

Kept: Python 3.13 + uv, ruff (line-length 120, `E,F,I,N,W,UP,B,C4,SIM,PTH`), mypy `strict`,
pytest + asyncio + cov, the both-ruff-gates CI discipline, `pip-audit`, the `.claude/` SDLC
skills (18 of 23), and the hook-based guardrails — retargeted from "no `terraform apply`" to
"no force-push, no hard reset, no registry publish, no repo deletion".

Dropped: everything Kafka, AWS, Terraform and Protobuf, plus the `aws-*`, `streaming-architect`
and `data-architect` skills.

---

## Deliberately out of scope

Networked play across devices, accounts, persistence beyond a save file, mobile apps, elaborate
sound design, custom board editing, and any use of the trademarked product's name or artwork.

## Known gap

**The Israeli board's city names are not in the repo** (MON-503). The board *structure* exists
and is fully valid — its 40 tiles use positional keys — but the names must come from a verified
source rather than from a plausible-looking guess, because a fabricated board would look
correct and never be re-checked. A test asserts the catalogue is absent so the gap cannot be
quietly half-filled.

---

**Owner**: Guy Flenner · **Started**: 2026-07-25
