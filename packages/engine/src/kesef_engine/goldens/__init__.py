"""Golden-game regeneration (MON-107) — a separate entry point, on purpose.

The regenerator lives in ``__main__`` and runs only as::

    python -m kesef_engine.goldens --regenerate

The tests in ``packages/engine/tests/test_goldens.py`` import nothing from this package:
they read the committed JSON and replay it through ``apply_all``. That separation, plus
the CI step that fails on an uncommitted diff under ``packages/engine/tests/goldens/``,
is what makes silent regeneration structurally impossible rather than merely forbidden.
"""
