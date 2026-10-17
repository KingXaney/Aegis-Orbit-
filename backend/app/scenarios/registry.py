"""Scenario definitions and construction."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from ..data.catalog import Catalog
from ..physics.time_utils import iso
from . import real, synthetic


@dataclass
class Scenario:
    scenario_id: str
    name: str
    kind: str  # real | synthetic
    description: str
    primary_id: str
    catalog: Catalog
    start_unix: float
    end_unix: float
    rendered_object_ids: List[str]
    pc_policy: str
    disclaimers: List[str] = field(default_factory=list)
    highlight_object_ids: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "scenario_id": self.scenario_id,
            "name": self.name,
            "kind": self.kind,
            "description": self.description,
            "primary_id": self.primary_id,
            "window": {"start": iso(self.start_unix), "end": iso(self.end_unix),
                       "start_unix": self.start_unix, "end_unix": self.end_unix},
            "object_count": len(self.catalog),
            "rendered_object_ids": list(self.rendered_object_ids),
            "highlight_object_ids": list(self.highlight_object_ids),
            "pc_policy": self.pc_policy,
            "data_source": self.catalog.source_info,
            "rejected_records": len(self.catalog.rejected),
            "disclaimers": list(self.disclaimers),
        }


COMMON_DISCLAIMERS = [
    "Research and simulation prototype. Nothing here commands a real spacecraft.",
    "Objects, markers and danger regions are enlarged for visibility; distances in the panels are the computed values.",
]


def build_synthetic() -> Scenario:
    cat = synthetic.build_synthetic_catalog()
    w = synthetic.scenario_window()
    return Scenario(
        scenario_id=synthetic.SCENARIO_ID,
        name="Scripted conjunction (synthetic)",
        kind="synthetic",
        description="Deterministic demonstration: a synthetic primary on a 420 km orbit meets a debris object on a "
                    "crossing orbit three hours into the window. All states are generated, not observed.",
        primary_id=synthetic.PRIMARY_ID,
        catalog=cat,
        start_unix=w["start_unix"], end_unix=w["end_unix"],
        rendered_object_ids=[o.object_id for o in cat.values()],
        pc_policy="provided_only",
        disclaimers=COMMON_DISCLAIMERS + [
            "Covariances in this scenario are illustrative scenario definitions, not measured uncertainties.",
        ],
        highlight_object_ids=[synthetic.SECONDARY_ID],
    )


def build_real(live: bool = False) -> Scenario:
    cat = real.build_live_catalog() if live else real.load_fixture_catalog()
    w = real.scenario_window(cat)
    real.flag_stale_records(cat, w["start_unix"])
    primary = cat.require(real.PRIMARY_ID)
    # Render the primary plus the objects closest to it in altitude band (bounded for browser performance).
    others = sorted(cat.others(real.PRIMARY_ID),
                    key=lambda o: abs(0.5 * ((o.perigee_alt_km or 0) + (o.apogee_alt_km or 0)) -
                                      0.5 * ((primary.perigee_alt_km or 0) + (primary.apogee_alt_km or 0))))
    rendered = [real.PRIMARY_ID] + [o.object_id for o in others[:80]]
    src = cat.source_info
    return Scenario(
        scenario_id=real.SCENARIO_ID,
        name="ISS vs. cataloged objects (real GP data)",
        kind="real",
        description="ISS (NORAD 25544) screened against cached CelesTrak objects whose altitude band overlaps "
                    "the station's. Positions are SGP4 estimates from public mean elements; no covariance is "
                    "available, so collision probabilities are reported as UNVERIFIED unless the illustrative "
                    "policy is explicitly selected.",
        primary_id=real.PRIMARY_ID,
        catalog=cat,
        start_unix=w["start_unix"], end_unix=w["end_unix"],
        rendered_object_ids=rendered,
        pc_policy="provided_only",
        disclaimers=COMMON_DISCLAIMERS + [
            f"Elements retrieved {src.get('retrieved_at') or 'unknown'}; accuracy degrades with age from each epoch.",
            "No conjunction is forced in this scenario. If nothing noteworthy appears, switch to the synthetic one.",
        ],
    )


BUILDERS: Dict[str, Callable[[], Scenario]] = {
    synthetic.SCENARIO_ID: build_synthetic,
    real.SCENARIO_ID: build_real,
}


def list_scenarios() -> List[Dict[str, Any]]:
    return [
        {"scenario_id": synthetic.SCENARIO_ID, "name": "Scripted conjunction (synthetic)", "kind": "synthetic"},
        {"scenario_id": real.SCENARIO_ID, "name": "ISS vs. cataloged objects (real GP data)", "kind": "real"},
    ]


def build_scenario(scenario_id: str, live: bool = False) -> Scenario:
    if scenario_id == real.SCENARIO_ID:
        return build_real(live=live)
    builder = BUILDERS.get(scenario_id)
    if builder is None:
        raise KeyError(f"unknown scenario '{scenario_id}'")
    return builder()
