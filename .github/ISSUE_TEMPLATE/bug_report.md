---
name: Bug report
about: Something behaved wrongly. Bring the seed and we can reproduce it exactly.
title: ""
labels: bug
assignees: ""
---

## The seed and the moves

**This is the most useful thing in the whole report.** A game here is fully reproducible from its
seed: `state.rng` is part of the serialized state, so a seed plus the commands played is an exact
reconstruction of what you saw — not an approximation of it. With those two, a maintainer turns
this issue into a failing test in about a minute. Without them, it is guesswork.

- **Seed**: <!-- the number under "More settings" on the setup screen; if you left it blank, say so -->
- **Board**: <!-- classic (Atlantic City) / israel -->
- **Ruleset**: <!-- universal (full rules) / kids -->
- **Language**: <!-- en / he -->
- **Seats**: <!-- e.g. person "Ruti" + easy bot "Dan" -->

**The moves, in order** — the "What's happened" panel is a good enough transcript; paste it, or
list the buttons you pressed:

```
1. Roll the dice
2. Buy this square
3. End turn
...
```

If you have a save file, attaching it is even better than the above.

## What happened

<!-- What the game did. If a figure was wrong, give the figure. -->

## What you expected instead

<!-- And, where it helps, which rule you expected to apply. Rent, jail, auctions and
     bankruptcy are the four places where the universal rules and household variants
     most often differ, so "the rules I know say X" is genuinely useful context. -->

## Which layer you think it is (optional, and a guess is fine)

- [ ] **The rules** — a figure, a phase, or a legal/illegal move was wrong
- [ ] **The screen** — the right thing happened but was drawn or worded wrongly
- [ ] **Hebrew / right-to-left** — something did not mirror, or read in the wrong direction
- [ ] **Accessibility** — keyboard, focus, screen reader, contrast, or hit-target size
- [ ] Not sure

## Where you were running it

- **Browser and version**:
- **OS**:
- **Commit or branch**: <!-- `git rev-parse --short HEAD` -->

## Screenshot

<!-- Optional, but a picture of the board settles a layout question instantly.
     For an RTL issue, one screenshot per language is worth a paragraph. -->

---

*Please describe the game as the classic property-trading ruleset. This project deliberately does
not carry the trademarked name of any branded product, including in issue titles.*
