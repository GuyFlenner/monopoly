"""MON-740 — the package's first page has to work.

``kesef_engine.__init__``'s docstring opens with "the public surface is deliberately tiny" and
then demonstrates it. That example is the first thing a reader of this package meets, and until
this test existed it was checked by nobody: two of the three names it called — ``apply`` and
``legal_commands`` — were not exported at all, so the block as printed raised ``NameError`` on
its second line. A docstring that does not run is not documentation, it is a claim.

Read out of the docstring rather than retyped here, which is the whole point. A copy would go
stale in the same silence the original did.
"""

from __future__ import annotations

import ast
from typing import Any

import pytest

import kesef_engine

LITERAL_BLOCK_MARKER = "::"
"""reStructuredText's introduction to an indented code block — how the example is delimited."""


def _example() -> str:
    """The indented block following the docstring's ``::``, dedented.

    Located by structure rather than by line numbers so that editing the prose above it does not
    silently point this test at nothing.
    """
    docstring = kesef_engine.__doc__
    assert docstring is not None, "the package docstring is the thing under test"
    lines = docstring.splitlines()
    start = next(index for index, line in enumerate(lines) if line.rstrip().endswith(LITERAL_BLOCK_MARKER)) + 1
    block = [line for line in lines[start:] if not line.strip() or line.startswith("    ")]
    while block and not block[0].strip():
        block.pop(0)
    while block and not block[-1].strip():
        block.pop()
    assert block, "no indented example follows the `::` — the docstring's promise has gone"
    return "\n".join(line[4:] for line in block)


def _free_names(source: str) -> set[str]:
    """Names the example *reads* without having bound them first.

    Anything left is something the example expects to find in the package's namespace, which is
    exactly the set ``__all__`` has to cover.
    """
    tree = ast.parse(source)
    bound = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store)}
    return {
        node.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id not in bound
    }


def test_every_name_in_the_docstring_example_resolves_off_the_package_root() -> None:
    """The defect as it was: ``apply`` and ``legal_commands`` demonstrated but not exported.

    Both are importable from their own modules, so nothing was broken — but the example promises a
    surface, and a reader following it got ``NameError`` on line two and no way to tell whether the
    docstring or the package was wrong.
    """
    names = sorted(_free_names(_example()))
    assert names, "the example calls nothing — it has stopped demonstrating a surface"
    missing = [name for name in names if name not in kesef_engine.__all__]
    assert not missing, f"the example names these and `__all__` does not carry them: {missing}"
    unresolvable = [name for name in names if not hasattr(kesef_engine, name)]
    assert not unresolvable, f"listed in `__all__` and not actually importable: {unresolvable}"


def test_the_docstring_example_runs_as_written() -> None:
    """Resolution is not enough: a name can exist and the call still be wrong.

    ``new_game(config)`` is what the example used to say, and ``new_game`` takes ``seats`` and a
    keyword-only ``seed`` — so the block would have failed on its *first* line too, for a reason no
    amount of checking ``__all__`` could see. Executed against the package namespace and nothing
    else, so an example that quietly relies on an import it does not show fails here.
    """
    namespace: dict[str, Any] = {name: getattr(kesef_engine, name) for name in kesef_engine.__all__}
    exec(compile(_example(), "<kesef_engine docstring>", "exec"), namespace)  # noqa: S102
    assert namespace["events"], "the example's `apply` produced no events — it is not doing anything"


def test_everything_exported_is_importable_and_named_once() -> None:
    """``__all__`` is the contract; a name in it that does not resolve is a broken import for a
    caller doing ``from kesef_engine import *`` and nothing at all for anybody else, which is why
    it can rot unnoticed."""
    assert sorted(kesef_engine.__all__) == list(kesef_engine.__all__), "keep `__all__` sorted"
    assert len(set(kesef_engine.__all__)) == len(kesef_engine.__all__), "a name is listed twice"
    for name in kesef_engine.__all__:
        assert hasattr(kesef_engine, name), f"exported and not importable: {name}"


@pytest.mark.parametrize("name", ("apply", "legal_commands", "GameState", "Command", "Event"))
def test_the_names_mon_740_added_are_the_same_objects_as_their_modules(name: str) -> None:
    """Re-exported, not redefined. A second definition under the same name is the kind of drift
    that makes ``isinstance`` checks fail across two import paths for one class."""
    import importlib

    source = {
        "apply": "kesef_engine.reducer",
        "legal_commands": "kesef_engine.legality",
        "GameState": "kesef_engine.state",
        "Command": "kesef_engine.commands",
        "Event": "kesef_engine.events",
    }[name]
    assert getattr(kesef_engine, name) is getattr(importlib.import_module(source), name)
