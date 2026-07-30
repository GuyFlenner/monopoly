# ADR-009 — Bots may construct trades; the driver rations them

- **Status**: Accepted
- **Date**: 2026-07-30
- **Deciders**: Guy Flenner
- **Amends**: the `Bot.choose` contract in `packages/engine/src/kesef_engine/bots/base.py`
- **Does not amend**: ADR-005. `ProposeTrade` stays out of `legal_commands`.

## Context

MON-602's normal bot passed its strength gate and failed its finishing gate:

> 69/100 wins (needed 60), 0 draws, **12 capped** (max 5), turns min/median/max 22/114/501

Two attempts to tune it out failed (building past three houses: 69→72 wins, 16→13 capped;
opponent-aware group valuation: no change at all). Dumping a capped position showed why the
tuning could not have worked:

```
seed 9, turn 501:  normal owns 12, easy owns 16, houses = 0 for BOTH
every colour group split:  brown [0,1]  light_blue [1,0,1]  pink [1,0,1]  red [1,0,0] ...
```

**Every colour group is split, so neither side can ever build.** Rents stay at their printed
value, both seats bank GO salaries faster than they lose them, and the game has no way to be
decided. In the rules as implemented, exactly one mechanism un-splits a colour group: a trade.

And no bot could propose one. `Bot.choose` promised to return a member of the `legal` tuple, and
`legal_commands` never enumerates `ProposeTrade` — ADR-005's second documented exception,
because the offer space (every subset of two estates, plus cash, plus jail cards, either way) is
unbounded and enumerating it is not a thing a hot-path function can do. So trades were
structurally unreachable to every bot, and MON-602's own fourth acceptance criterion, "sane
trade evaluation", was implemented only as *responding*.

Three options were on the table and the other two were rejected first, because both change the
measurement rather than the bot:

- **Play the contest with more than two seats**, where a group is likelier to end up
  concentrated in one hand. Cheap, and it changes the stated contest after seeing the result —
  the G-62 trap the fixed thresholds exist to prevent.
- **Raise `MAX_CAPPED`.** The threshold was fixed in advance precisely so it would not move to
  fit a result, and "a bot that cannot close out a game is itself a failure" is the standard
  worth keeping.

## Decision

### 1. The enumeration exception stands

`legal_commands` still never returns a `ProposeTrade`. Nothing about the offer space changed and
nothing about ADR-005's reasoning changed. The UI's trade builder still validates its draft
through `is_legal` / the `validate` route, and it is now joined by a second caller doing the same
thing for the same reason.

### 2. `Bot.choose` may return a constructed `ProposeTrade`

The contract loosens from

> returns a member of `legal`

to

> returns a member of `legal`, **or** a `ProposeTrade` that `is_legal` accepts.

`ProposeTrade` and nothing else. Every other command kind *is* enumerated, so for those the
original promise still says everything there is to say, and a bot inventing one would be a bot
guessing at rules it has been handed the answer to.

A constructed offer earns no privilege. The bot asks `is_legal` before returning it, and `apply`
validates it again through the same predicate that validates a human's draft — ownership, cash,
the group-carrying-buildings veto, `trading_enabled`, `simplified_trades`. The property that
makes "the bot cheated" un-implementable is unchanged: there is still no path into the state that
a human does not have, and the bot still holds no rule logic of its own. What it holds is a
*preference* over legal offers, which is what a bot is.

### 3. A driver gives each bot seat one proposal per turn

`choose` gains a keyword-only `may_trade: bool = True`. With `may_trade=False` a bot must not
return a `ProposeTrade`. The *caller* decides, and the rule both drivers implement is: after a
seat returns one `ProposeTrade` in its turn, that seat is asked with `may_trade=False` for the
rest of the turn — accepted or declined, one attempt — and a new turn refills it.

The reasoning is the reason it lives in the driver rather than anywhere else:

- **A bot is a pure function of `(state, player, legal)`.** That is what makes a bot game
  reproducible from its seed and command list, and it is asserted in `test_bot_easy.py`.
- **Declining a trade returns the position to essentially what it was.** The interrupt frame is
  pushed and popped; no cash moves, no deed moves.
- Therefore a bot asked again from the same position **re-proposes the identical offer, forever**.
  It is not a hypothetical: with the guard removed, `tournament.play` runs into its 40 000-command
  step cap on the first seed, and against a human seat it would be a Decline button that summons
  the same trade straight back.

Two rejected places to put it, both worse:

- **Memory inside the bot.** A bot with memory is a second place the game's history lives, and it
  breaks replay-from-seed — the exact defect `easy.py`'s docstring exists to warn about.
- **A flag in `GameState`.** "This seat has already offered a trade this turn" is not a rule of
  the game; it is a policy about how often a computer opponent is allowed to interrupt. Putting it
  in the engine would make it part of the save file and part of the rules, and a human player is
  under no such limit.

The two drivers express the same rule differently because they are re-entered differently, and
the difference is worth naming rather than hiding:

- `packages/engine/tests/tournament.py` owns its whole loop, so it keeps a set and clears it when
  `turn_number` moves.
- `kesef_server/bots.py` is driven one move per call (`_advance_bots` passes `max_steps=1`), and a
  proposal to a human seat ends the call altogether — the next call happens in the *next HTTP
  request*, after the human has answered. A driver-local memory would have reset by then. So the
  fact is read off the session's event log: `TradeProposed` since the last `TurnStarted`. The log
  is the game's own record of what has already happened, which is the right place to ask.

## Alternatives considered

**Enumerate a bounded subset of trades in `legal_commands`** — say, every single-tile-for-single-tile
swap. It would keep the protocol untouched, and it is the wrong trade: 40 tiles by 6 players makes
`legal_commands` quadratic on a function that runs on every render (ADR-005's last consequence
says so in as many words), and the subset is arbitrary — the moment a bot wants cash in the offer,
the exception is back.

**A separate `Bot.propose` method**, called by the driver at defined points. Honest, and it splits
one decision — "what is the best thing to do now" — across two methods that would then need a
priority rule between them. The bot already scores every option against every other; a proposal is
just another option, and `PROPOSE_SCORE` places it in the same ranking.

**Let `apply` reject a repeated identical offer.** Would work, and it would put a rule in the
engine that is not a rule of the game. A human may re-offer the same trade as often as the other
player will listen.

## Consequences

- MON-602 passes both gates. Measured over the same fixed 100 games: **74/100 wins, 0 draws,
  0 capped, turns min/median/max 22/83/206**. The maximum game length fell from 501 to 206 —
  games now end because rent gets big, which is how the game is supposed to end.
- The contest is now asserted in the suite rather than reported in the backlog
  (`test_bot_normal.py::TestTheStrengthGate`, ~25 s). It was left out while only the flattering
  half of it passed.
- **The bot's best trade helps its opponent too**, by design: a reciprocal swap completes a group
  for each side. A board where both sides can build is a board somebody loses, and that is the
  point of the gate.
- Nothing on the wire changes. `may_trade` is a keyword argument between a driver and a bot inside
  one process; `ProposeTrade` was already a wire command with a schema, because humans send it.
- MON-603's hard bot inherits both halves: it may search the offer space as widely as it likes, and
  it gets the same one proposal per turn.
- A new bot author has one more thing they can get wrong, and it is written down in the protocol's
  docstring rather than only here.
