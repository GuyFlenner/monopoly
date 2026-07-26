"""The RNG is the foundation of reproducibility, so it gets tested like one."""

from __future__ import annotations

from collections import Counter

import pytest

from kesef_engine.rng import Rng


def test_same_seed_same_sequence() -> None:
    left = [value for value, _ in _stream(Rng(seed=7), 50)]
    right = [value for value, _ in _stream(Rng(seed=7), 50)]
    assert left == right


def test_different_seeds_diverge() -> None:
    left = [value for value, _ in _stream(Rng(seed=7), 50)]
    right = [value for value, _ in _stream(Rng(seed=8), 50)]
    assert left != right


def test_rng_is_immutable_and_advances() -> None:
    original = Rng(seed=1)
    _, advanced = original.next_u64()
    assert original.counter == 0
    assert advanced.counter == 1


def test_a_saved_rng_resumes_the_same_stream() -> None:
    """The whole point: (seed, counter) is enough to resume mid-game."""
    rng = Rng(seed=99)
    for _ in range(10):
        _, rng = rng.next_u64()
    restored = Rng.model_validate_json(rng.model_dump_json())
    assert restored.next_u64()[0] == rng.next_u64()[0]


def test_seeking_is_o1_not_replay() -> None:
    """Jumping straight to draw 1000 gives the same value as drawing 1000 times."""
    replayed = Rng(seed=5)
    for _ in range(1000):
        _, replayed = replayed.next_u64()
    seeked = Rng(seed=5, counter=1000)
    assert seeked.next_u64()[0] == replayed.next_u64()[0]


def test_streams_are_independent() -> None:
    """Shuffling a deck must not shift the dice sequence."""
    dice = Rng(seed=3, stream=0)
    deck = Rng(seed=3, stream=1)
    assert dice.next_u64()[0] != deck.next_u64()[0]


def test_fork_resets_the_counter() -> None:
    rng = Rng(seed=3, counter=17)
    forked = rng.fork(stream=4)
    assert (forked.seed, forked.counter, forked.stream) == (3, 0, 4)


def test_dice_are_in_range() -> None:
    rng = Rng(seed=11)
    for _ in range(500):
        first, second, rng = rng.roll_dice()
        assert 1 <= first <= 6
        assert 1 <= second <= 6


def test_dice_are_roughly_uniform() -> None:
    """A loaded die would quietly break game balance, so check the distribution."""
    rng = Rng(seed=2024)
    counts: Counter[int] = Counter()
    rolls = 60_000
    for _ in range(rolls):
        face, rng = rng.roll_die()
        counts[face] += 1
    expected = rolls / 6
    assert len(counts) == 6
    for face in range(1, 7):
        assert abs(counts[face] - expected) < expected * 0.05, counts


def test_doubles_appear_about_one_roll_in_six() -> None:
    rng = Rng(seed=555)
    doubles = 0
    rolls = 30_000
    for _ in range(rolls):
        first, second, rng = rng.roll_dice()
        doubles += first == second
    assert abs(doubles / rolls - 1 / 6) < 0.01


def test_below_rejects_non_positive_bounds() -> None:
    with pytest.raises(ValueError, match="bound must be positive"):
        Rng(seed=1).below(0)


def test_shuffle_is_a_permutation_and_deterministic() -> None:
    deck = tuple(range(16))
    first, _ = Rng(seed=4).shuffled(deck)
    again, _ = Rng(seed=4).shuffled(deck)
    other, _ = Rng(seed=5).shuffled(deck)
    assert sorted(first) == list(deck)
    assert first == again
    assert first != other


def _stream(rng: Rng, count: int) -> list[tuple[int, Rng]]:
    out = []
    for _ in range(count):
        value, rng = rng.next_u64()
        out.append((value, rng))
    return out
