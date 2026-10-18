"""In-memory orbital object catalog.

Every object carries its data provenance (source, epoch, retrieval time), the
propagation model that applies to it, and explicit uncertainty metadata
(hard-body radius and covariance, each with a *basis* label saying whether the
value was provided, assumed, or is unavailable).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple

import numpy as np
from sgp4.api import Satrec

from ..physics.time_utils import iso
from .spacecraft import SpacecraftDesign, design_for

CATEGORY_DEFAULT_RADIUS_M = {"PAYLOAD": 5.0, "ROCKET_BODY": 5.0, "DEBRIS": 1.0, "UNKNOWN": 2.0}


@dataclass(frozen=True, eq=False)
class Segment:
    """One committed-burn arc of a piecewise trajectory.

    ``t_start_unix`` is the burn time: the arc is valid from there until the next burn and never
    changes. ``epoch_unix``/``r0_km``/``v0_kms`` is the integration anchor: the post-burn state when
    the burn is committed, moved along the arc by re-anchoring (see propagation.anchored).
    """
    t_start_unix: float
    epoch_unix: float
    r0_km: np.ndarray
    v0_kms: np.ndarray
    maneuver_id: str
    dv_mps: float = 0.0
    direction: str = ""

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Segment):
            return NotImplemented
        return (self.t_start_unix == other.t_start_unix and self.epoch_unix == other.epoch_unix
                and self.maneuver_id == other.maneuver_id and self.dv_mps == other.dv_mps
                and self.direction == other.direction and np.array_equal(self.r0_km, other.r0_km)
                and np.array_equal(self.v0_kms, other.v0_kms))

    def to_dict(self) -> Dict[str, Any]:
        return {"maneuver_id": self.maneuver_id, "burn_time": iso(self.t_start_unix),
                "burn_time_unix": float(self.t_start_unix), "dv_mps": float(self.dv_mps), "direction": self.direction,
                "anchor_epoch_unix": float(self.epoch_unix)}


@dataclass
class OrbitalObject:
    object_id: str
    name: str
    category: str = "UNKNOWN"  # PAYLOAD | DEBRIS | ROCKET_BODY | UNKNOWN
    category_basis: str = "UNKNOWN"  # INFERRED_FROM_NAME | SCENARIO_DEFINITION
    source: str = "unknown"  # celestrak | synthetic
    source_detail: str = ""
    epoch: Optional[datetime] = None
    retrieved_at: Optional[datetime] = None
    propagation_model: str = "SGP4"  # SGP4 | NUMERICAL_J2
    position_basis: str = "PROPAGATED_FROM_GP_ELEMENTS"  # or SYNTHETIC_STATE
    norad_id: Optional[int] = None
    intl_designator: Optional[str] = None
    tle_line1: Optional[str] = None
    tle_line2: Optional[str] = None
    satrec: Optional[Satrec] = field(default=None, repr=False, compare=False)
    state_epoch_unix: Optional[float] = None
    r0_teme_km: Optional[np.ndarray] = field(default=None, repr=False, compare=False)
    v0_teme_kms: Optional[np.ndarray] = field(default=None, repr=False, compare=False)
    radius_m: float = 5.0
    radius_basis: str = "ASSUMED_DEFAULT"  # SCENARIO_DEFINITION | ASSUMED_DEFAULT
    covariance_rtn_m2: Optional[np.ndarray] = field(default=None, repr=False, compare=False)
    covariance_source: str = "UNAVAILABLE"  # PROVIDED | ASSUMED_ILLUSTRATIVE | UNAVAILABLE
    perigee_alt_km: Optional[float] = None
    apogee_alt_km: Optional[float] = None
    period_s: Optional[float] = None
    inclination_deg: Optional[float] = None
    design_override: Optional[SpacecraftDesign] = field(default=None, repr=False)
    warnings: List[str] = field(default_factory=list)
    validation_status: str = "OK"  # OK | STALE | INVALID
    # Committed burns turn the object into a PIECEWISE_J2 one: its native model, basis and orbit summary
    # are kept here so the original can be restored, and the burn arcs follow in time order.
    base_model: str = ""
    base_position_basis: str = ""
    base_summary: Optional[Dict[str, Any]] = field(default=None, repr=False, compare=False)
    segments: Tuple[Segment, ...] = ()
    # Sandbox junk: when it was spawned (simulation time) and the designed encounter it was built from.
    spawned_at_unix: Optional[float] = None
    spawn: Optional[Dict[str, Any]] = field(default=None, repr=False, compare=False)

    @property
    def epoch_unix(self) -> Optional[float]:
        return self.epoch.timestamp() if self.epoch else None

    @property
    def design(self) -> SpacecraftDesign:
        """Physical design and envelope; generic shapes follow the current hard-body radius."""
        return self.design_override or design_for(self.norad_id, self.category, self.radius_m)

    def covariance_sigmas_m(self) -> Optional[List[float]]:
        if self.covariance_rtn_m2 is None:
            return None
        return [float(np.sqrt(max(self.covariance_rtn_m2[i, i], 0.0))) for i in range(3)]

    def summary(self) -> Dict[str, Any]:
        return {
            "object_id": self.object_id,
            "name": self.name,
            "category": self.category,
            "category_basis": self.category_basis,
            "norad_id": self.norad_id,
            "intl_designator": self.intl_designator,
            "source": self.source,
            "source_detail": self.source_detail,
            "epoch": iso(self.epoch) if self.epoch else None,
            "retrieved_at": iso(self.retrieved_at) if self.retrieved_at else None,
            "propagation_model": self.propagation_model,
            "position_basis": self.position_basis,
            "perigee_alt_km": self.perigee_alt_km,
            "apogee_alt_km": self.apogee_alt_km,
            "period_s": self.period_s,
            "inclination_deg": self.inclination_deg,
            "radius_m": self.radius_m,
            "radius_basis": self.radius_basis,
            "covariance_source": self.covariance_source,
            "covariance_sigmas_rtn_m": self.covariance_sigmas_m(),
            "design": self.design.as_dict(),
            "validation_status": self.validation_status,
            "warnings": list(self.warnings),
            "base_model": self.base_model or None,
            "burns": [s.to_dict() for s in self.segments],
            "spawned_at": iso(self.spawned_at_unix) if self.spawned_at_unix is not None else None,
            "spawned_at_unix": self.spawned_at_unix,
            "spawn": dict(self.spawn) if self.spawn else None,
        }


class Catalog:
    """Ordered collection of orbital objects plus the records rejected on load."""

    def __init__(self, objects: Iterable[OrbitalObject] = (), rejected: Optional[List[Dict[str, Any]]] = None,
                 source_info: Optional[Dict[str, Any]] = None):
        self.objects: Dict[str, OrbitalObject] = {}
        for o in objects:
            self.objects[o.object_id] = o
        self.rejected: List[Dict[str, Any]] = list(rejected or [])
        self.source_info: Dict[str, Any] = dict(source_info or {})
        # Bumped on every add/replace, so caches keyed on the catalog notice changes.
        self.version: int = 0

    def __len__(self) -> int:
        return len(self.objects)

    def __contains__(self, object_id: str) -> bool:
        return object_id in self.objects

    def get(self, object_id: str) -> Optional[OrbitalObject]:
        return self.objects.get(object_id)

    def require(self, object_id: str) -> OrbitalObject:
        obj = self.objects.get(object_id)
        if obj is None:
            raise KeyError(f"unknown object '{object_id}'")
        return obj

    def add(self, obj: OrbitalObject) -> None:
        if obj.object_id in self.objects:
            raise ValueError(f"object '{obj.object_id}' already exists in the catalog")
        self.objects[obj.object_id] = obj
        self.version += 1

    def remove(self, object_id: str) -> OrbitalObject:
        """Drop an object (sandbox junk the user takes away)."""
        if object_id not in self.objects:
            raise KeyError(f"unknown object '{object_id}'")
        obj = self.objects.pop(object_id)
        self.version += 1
        return obj

    def replace(self, obj: OrbitalObject, *, bump_version: bool = True) -> None:
        """Swap in a new record for an existing id (objects are immutable: never mutate one in place)."""
        if obj.object_id not in self.objects:
            raise KeyError(f"unknown object '{obj.object_id}'")
        self.objects[obj.object_id] = obj
        if bump_version:
            self.version += 1

    # Iteration works on a snapshot: a spawn from another request must not break a running screening.
    def values(self) -> List[OrbitalObject]:
        return list(tuple(self.objects.values()))

    def others(self, object_id: str) -> List[OrbitalObject]:
        return [o for o in tuple(self.objects.values()) if o.object_id != object_id]

    def valid_objects(self) -> List[OrbitalObject]:
        return [o for o in tuple(self.objects.values()) if o.validation_status != "INVALID"]
