---
name: Feature request
about: Something the game should do that it does not do yet.
title: ""
labels: enhancement
assignees: ""
---

## What should be possible

<!-- Describe it from a player's seat rather than as an implementation. "A parent can see why
     their child owes 750" is a better opening than "add a rent tooltip", because it leaves the
     design open and states the thing that has to end up true. -->

## Who it is for

<!-- The audience here is 2–6 players including six-year-olds, colourblind adults, screen-reader
     users, keyboard-only users, and Hebrew readers. Saying which of those you have in mind
     usually decides the design on its own. -->

## Why it is worth doing

<!-- What is annoying or impossible today. If you hit this while playing, say what happened. -->

## Have you checked the backlog?

- [ ] I looked at [`docs/BACKLOG.md`](../../docs/BACKLOG.md) and this is not already filed

Much of what people ask for is already scheduled — the hard bot, the animation queue, the
side-by-side compare tray, save/load, the replay viewer, hints and sound cues all have items. If
yours is there, a comment on the priority is more useful than a new issue. `docs/BACKLOG.md` §E9
also lists what is deliberately deferred past v1, with the reason.

## Where it would live (optional)

Worth a thought, because it decides who can build it and how it gets tested:

- [ ] **A rule** — it changes what is legal, what is owed, or how a turn proceeds. It belongs in
      `packages/engine`, returns i18n keys rather than prose, and owes a unit test, a golden touch
      and an invariant where one applies.
- [ ] **A projection or contract gap** — the engine knows it but the client cannot see it, so the
      UI would otherwise compute or translate something it has no business knowing.
- [ ] **Presentation** — the facts are all on the wire already and this is about what a player
      sees, hears or reaches.
- [ ] Not sure

## Things this project has already decided against

So an idea is not proposed twice in good faith: networked play across devices, accounts,
persistence beyond a save file, mobile apps, elaborate sound design, custom board editing, and any
use of a branded product's name or artwork. The engine is already command-in/event-out and the
server is already authoritative, so networked play is deferred rather than designed out — but it is
not v1.

## New game data

If your request needs board names, city names or card text, please bring a **verified source**. A
plausible-looking fabricated board is worse than a missing one, because it looks correct and nobody
re-checks it.

---

*Please describe the game as the classic property-trading ruleset. This project deliberately does
not carry the trademarked name of any branded product, including in issue titles.*
