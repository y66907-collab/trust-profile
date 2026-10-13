"""Tabu cross-check: is the landlord in the contract the registered owner?

This is our edge (from the Tabu extraction work). Interface only.
TODO: plug in the Tabu extract lookup (נסח טאבו) by gush/helka and compare owner names.
Name matching must be fuzzy (Hebrew spelling variants, initials, multiple owners).
"""

from typing import Protocol


class TabuLookup(Protocol):
    def owners(self, gush: str, helka: str, sub_helka: str | None = None) -> list[str]: ...


class NullTabuLookup:
    """Default: no lookup configured. Returns no owners -> no upgrade."""

    def owners(self, gush: str, helka: str, sub_helka: str | None = None) -> list[str]:
        return []


def _norm(name: str) -> str:
    return " ".join(name.replace("-", " ").replace('"', "").split()).strip()


def landlord_is_registered_owner(lookup: TabuLookup, landlord_name: str, gush_helka: str | None) -> bool:
    if not gush_helka:
        return False
    parts = gush_helka.replace("/", "-").split("-")
    if len(parts) < 2:
        return False
    owners = [_norm(o) for o in lookup.owners(parts[0], parts[1], parts[2] if len(parts) > 2 else None)]
    target = _norm(landlord_name)
    return any(target == o or set(target.split()) <= set(o.split()) for o in owners)
