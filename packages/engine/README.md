# kesef-engine

The rules core. Pure Python, one dependency (pydantic), no I/O, no framework, no opinions
about how the game is displayed.

```python
from kesef_engine import load_board
from kesef_engine.legality import legal_commands
from kesef_engine.reducer import apply

board = load_board("classic")
state, events = apply(state, command)
```

## The three rules of this package

1. **No I/O.** The only file it reads is its own bundled board JSON.
2. **No prose.** Everything human-facing is an i18n *key* — `tile.classic.boardwalk`,
   `error.not_your_turn`. This is why the Hebrew build is a translation exercise and not a
   code change.
3. **Deterministic.** Randomness lives in `Rng(seed, counter)`, which is part of the state.
   Same seed plus same commands means the same game, always.

## Why it is shaped this way

`GameState` is one frozen, fully serializable value and `apply()` is a pure function. That
single decision pays for itself several times over:

| You get | Because |
|---|---|
| Save / load | `model_dump_json()` **is** the save file |
| Replay + regression tests | a seed and a command list reproduce a game exactly |
| Undo | keep the previous state; there is nothing else to roll back |
| Bot search | clone the state, play out hypotheticals, discard |
| Networked play later | commands in, events out, is already the wire protocol |

## Layout

```
board/       board data model, validation, loader, and the two bundled boards
rules/       one module per rule area (movement, rent, auction, ...)
bots/        the Bot protocol and the three difficulty levels
rng.py       splitmix64 — seekable, two integers of state
state.py     GameState and friends
commands.py  the closed set of things a player may do
events.py    the closed set of things that may happen
legality.py  what can be done right now — the UI renders from this
reducer.py   apply(state, command) -> (state, events)
cli.py       text-mode driver
```

## Try it

```bash
uv run kesef boards          # the bundled boards
uv run kesef show classic    # full layout and economics
uv run pytest packages/engine
```
