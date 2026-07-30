"""Rule variants as data.

The universal ruleset is the default and the reference. Kids Mode is the *same engine*
with features switched off — not a second implementation. Any rule that differs between
modes must read a flag from here, so that a variant can never silently fork the rules.

House rules that people play but the official rules do not sanction (money on Free
Parking, double salary for landing exactly on GO) are present but default to off, which
documents them as house rules rather than leaving them to be re-litigated.
"""

from __future__ import annotations

from enum import StrEnum
from typing import ClassVar

from pydantic import BaseModel, Field


class RulesetName(StrEnum):
    UNIVERSAL = "universal"
    KIDS = "kids"


class Ruleset(BaseModel, frozen=True):
    """A complete, serialized rule configuration. Part of the saved game."""

    IDENTITY_FIELDS: ClassVar[frozenset[str]] = frozenset({"name"})
    """Fields that say *which* rule set this is rather than what it does.

    ``name`` differs between every pair of rule sets by definition, so a list of what Kids mode
    changes that included it would open with "Rule set: kids (full rules: universal)" above the
    actual changes — and it is the one field whose value is an enum, which a diff row has no
    honest way to print. Named here rather than in the setup screen so the classification travels
    with the model (MON-417).
    """

    name: RulesetName

    # --- Economy -----------------------------------------------------------
    starting_cash: int = 1500
    go_salary: int = 200
    jail_fine: int = 50
    houses_available: int = 32
    hotels_available: int = 12

    # --- Feature switches --------------------------------------------------
    auctions_enabled: bool = True
    """Official rule: declining to buy sends the property to auction. Off in Kids Mode."""
    mortgages_enabled: bool = True
    trading_enabled: bool = True
    even_build_enforced: bool = True
    """Houses across a colour group may never differ by more than one."""
    # There is deliberately no ``building_shortage_enforced`` flag: the bank's stock is
    # finite in *every* ruleset, because ``GameState`` refuses to hold more buildings than
    # ``houses_available`` / ``hotels_available``. A more generous bank is a bigger number,
    # not a switched-off rule. What the shortage leaves open is who gets the last house,
    # and that is the flag below.
    building_shortage_auction: bool = False
    """Whether a contested last house goes to auction. Off in v1 (owner decision 1, GAP
    §7): buildings are first-come-first-served, a documented divergence from the printed
    rule. ``BuildingLot`` exists so turning this on later is a rule change, not a rework."""
    max_jail_turns: int = 3
    """Turns in jail before the fine is compulsory."""

    # --- House rules (off under the official rules) -------------------------
    free_parking_pot_enabled: bool = False
    """Renamed from ``free_parking_pot``, which collided with the *int* of the same name on
    ``GameState`` — one was a switch, the other the money on the tile."""
    double_salary_on_exact_go: bool = False

    # --- Child-friendliness -------------------------------------------------
    hints_enabled: bool = False
    """UI surfaces a suggested action and explains rent maths."""
    target_duration_minutes: int | None = None
    """Kids Mode: after this long, the richest player wins so games end while it is fun."""
    simplified_trades: bool = False
    """Property-for-property and property-for-cash only; no multi-item packages."""

    starting_cash_denominations: tuple[int, ...] = Field(
        default=(500, 100, 50, 20, 10, 5, 1),
        description="Only for UI presentation of the cash tray; the engine tracks a single integer.",
    )

    @classmethod
    def universal(cls) -> Ruleset:
        """The reference ruleset. This is what 'correct' means for the test suite."""
        return cls(name=RulesetName.UNIVERSAL)

    @classmethod
    def kids(cls) -> Ruleset:
        """Same rules, fewer sharp edges. Aimed at roughly ages 6-9."""
        return cls(
            name=RulesetName.KIDS,
            starting_cash=2000,
            auctions_enabled=False,
            mortgages_enabled=False,
            simplified_trades=True,
            hints_enabled=True,
            target_duration_minutes=45,
            max_jail_turns=1,
        )

    @classmethod
    def by_name(cls, name: RulesetName) -> Ruleset:
        return cls.universal() if name is RulesetName.UNIVERSAL else cls.kids()

    # --- What a setup screen needs in order to explain a variant (MON-417) ---

    @classmethod
    def setting_fields(cls) -> tuple[str, ...]:
        """Every field that is a *setting*, in declaration order.

        Declaration order rather than alphabetical, so a list of changes reads the same way twice
        running — a diff that reshuffles itself is one a parent cannot check against last week's
        game. Read off ``model_fields`` rather than hand-listed, which is what stops a flag added
        to this file from being silently unexplainable (the failure the setup screen's hand-kept
        ``Record<keyof Ruleset, …>`` map existed to catch, one layer too high).
        """
        return tuple(name for name in cls.model_fields if name not in cls.IDENTITY_FIELDS)

    @staticmethod
    def label_key(field: str) -> str:
        """The i18n key naming ``field`` to a player. Keys, never prose — ADR-003 §6.

        Mechanical from the wire field name on purpose, the same reasoning GAP G-40 applies to
        ``action.<command_kind>``: a hand-written bridge between the engine's vocabulary and the
        catalogue's is a bridge that can drift.
        """
        return f"ruleset.{field}"

    def differing_settings(self, baseline: Ruleset) -> frozenset[str]:
        """Which settings this rule set changes against ``baseline``.

        A comparison of two rule sets, not a judgement about a game — but it belongs here anyway,
        because what counts as a setting and how its values compare are facts about this model.
        The setup screen used to answer it in TypeScript over the raw flags (MON-408's stand-in for
        an unclosed G-36); a client that computes which rules are in force is one rename away from
        explaining the wrong ones.
        """
        return frozenset(field for field in self.setting_fields() if getattr(self, field) != getattr(baseline, field))
