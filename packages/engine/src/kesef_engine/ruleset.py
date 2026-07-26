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

from pydantic import BaseModel, Field


class RulesetName(StrEnum):
    UNIVERSAL = "universal"
    KIDS = "kids"


class Ruleset(BaseModel, frozen=True):
    """A complete, serialized rule configuration. Part of the saved game."""

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
    building_shortage_enforced: bool = True
    """When the bank runs out of houses, they genuinely run out."""
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
