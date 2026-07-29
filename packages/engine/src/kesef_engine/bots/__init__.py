"""Bot players.

A bot is just something that picks one command from the legal ones. That narrow
interface is deliberate: a bot cannot cheat, because it has no way to reach the state
except through the same door a human uses, and it cannot desync from the rules, because
the rules hand it its options.

Three levels ship (MON-601..603):

* ``easy``   — picks randomly among legal moves, but always buys what it can afford.
              Loses cheerfully; good for a six-year-old.
* ``normal`` — heuristics: keep a cash buffer, prefer completing colour groups, build to
              three houses (the best rent-per-pound tier), accept trades that improve its
              own group completion.
* ``hard``   — the heuristics plus short Monte-Carlo rollouts through
              :func:`kesef_engine.reducer.apply` on copies of the state. This is the payoff
              for keeping the engine pure and cheap to clone.
"""

from kesef_engine.bots.base import Bot, BotLevel
from kesef_engine.bots.easy import EasyBot
from kesef_engine.bots.normal import NormalBot

__all__ = ["Bot", "BotLevel", "EasyBot", "NormalBot"]
