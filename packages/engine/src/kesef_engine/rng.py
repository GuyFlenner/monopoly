"""Deterministic, serializable randomness.

``random.Random`` is a poor fit here: its internal Mersenne state is 2.5 KB and awkward
to round-trip through JSON, and restoring it means replaying every draw. Instead we use
a *counter-based* generator — splitmix64. The entire state is ``(seed, counter)``, two
integers, so a saved game carries its randomness for free and any position in the stream
is reachable in O(1).

Every draw returns a *new* ``Rng`` rather than mutating, which keeps
``apply(state, command)`` a pure function.
"""

from __future__ import annotations

from typing import Final

from pydantic import BaseModel, Field

_MASK64: Final = 0xFFFFFFFFFFFFFFFF
_GOLDEN_GAMMA: Final = 0x9E3779B97F4A7C15


def _splitmix64(x: int) -> int:
    """One splitmix64 mixing round. Reference: Steele, Lea & Flood (2014)."""
    z = (x + _GOLDEN_GAMMA) & _MASK64
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & _MASK64
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & _MASK64
    return (z ^ (z >> 31)) & _MASK64


class Rng(BaseModel, frozen=True):
    """A pure, seekable random stream.

    ``stream`` separates independent uses of the same seed so that, for example,
    shuffling the Chance deck cannot shift the sequence of dice rolls.
    """

    seed: int = Field(ge=0, le=_MASK64)
    counter: int = Field(default=0, ge=0)
    stream: int = Field(default=0, ge=0)

    def fork(self, stream: int) -> Rng:
        """Return an independent stream from the same seed."""
        return Rng(seed=self.seed, counter=0, stream=stream)

    def next_u64(self) -> tuple[int, Rng]:
        """Draw a 64-bit value and return it with the advanced generator."""
        mixed = _splitmix64(self.seed ^ (self.stream * _GOLDEN_GAMMA) ^ (self.counter * 0xD1B54A32D192ED03))
        return mixed, self.model_copy(update={"counter": self.counter + 1})

    def below(self, bound: int) -> tuple[int, Rng]:
        """Draw a uniform integer in ``[0, bound)``.

        Uses Lemire's multiply-shift with rejection so the result is free of the modulo
        bias that ``value % bound`` would introduce.
        """
        if bound <= 0:
            raise ValueError("bound must be positive")
        threshold = (-bound) % bound  # == 2**64 % bound
        rng = self
        while True:
            value, rng = rng.next_u64()
            if value >= threshold:
                return (value * bound) >> 64, rng

    def roll_die(self) -> tuple[int, Rng]:
        """Roll one six-sided die (1-6)."""
        value, rng = self.below(6)
        return value + 1, rng

    def roll_dice(self) -> tuple[int, int, Rng]:
        """Roll two six-sided dice. Returns ``(first, second, advanced_rng)``."""
        first, rng = self.roll_die()
        second, rng = rng.roll_die()
        return first, second, rng

    def shuffled(self, items: tuple[int, ...]) -> tuple[tuple[int, ...], Rng]:
        """Fisher-Yates shuffle, deterministic for a given ``(seed, stream, counter)``."""
        pool = list(items)
        rng = self
        for i in range(len(pool) - 1, 0, -1):
            j, rng = rng.below(i + 1)
            pool[i], pool[j] = pool[j], pool[i]
        return tuple(pool), rng
