"""Scenario definitions and construction."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from ..config import get_settings
from ..data.catalog import Catalog
from ..perception import perception
from ..physics import screening
from ..physics.time_utils import iso
from . import real, synthetic


@dataclass
class Scenario:
    scenario_id: str
    name: str
    kind: str  # real | synthetic | sandbox
    description: str
    primary_id: str
    catalog: Catalog
    start_unix: float
    end_unix: float
    rendered_object_ids: List[str]
    pc_policy: str
    disclaimers: List[str] = field(default_factory=list)
    highlight_object_ids: List[str] = field(default_factory=list)
    # Large catalogs only: the fixed ML shortlist every screening uses (perception.screening_shortlist).
    screening_shortlist: Optional[perception.ScreeningShortlist] = None

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
            "sandbox": self.kind == "sandbox",
            "screening_shortlist": self.screening_shortlist.public() if self.screening_shortlist else None,
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
        description="Deterministic demonstration: a synthetic primary on a 407 km, 65° orbit meets a run of debris "
                    "passes over six hours: one it only needs to monitor and three critical ones it dodges in turn, "
                    "each with the operator's approval. All states are generated, not observed.",
        primary_id=synthetic.PRIMARY_ID,
        catalog=cat,
        start_unix=w["start_unix"], end_unix=w["end_unix"],
        rendered_object_ids=[o.object_id for o in cat.values()],
        pc_policy="provided_only",
        disclaimers=COMMON_DISCLAIMERS + [
            "Covariances in this scenario are illustrative scenario definitions, not measured uncertainties.",
        ],
        highlight_object_ids=list(synthetic.CRITICAL_STAGED_IDS),
    )


def build_sandbox() -> Scenario:
    cat = synthetic.build_sandbox_catalog()
    w = synthetic.scenario_window()
    return Scenario(
        scenario_id=synthetic.SANDBOX_SCENARIO_ID,
        name="Sandbox: spawn junk, autopilot dodges",
        kind="sandbox",
        description="Live sandbox: the synthetic primary on its 407 km, 65° orbit with nothing staged. Drop space "
                    "junk into the world and the simulation screens it, plans an avoidance burn and flies it. "
                    "All states are generated, not observed; nothing here commands a spacecraft.",
        primary_id=synthetic.PRIMARY_ID,
        catalog=cat,
        start_unix=w["start_unix"], end_unix=w["end_unix"],
        rendered_object_ids=[o.object_id for o in cat.values()],
        pc_policy="provided_only",
        disclaimers=COMMON_DISCLAIMERS + [
            "Covariances in this scenario are illustrative scenario definitions, not measured uncertainties.",
            "Spawned junk near the spacecraft is drawn enlarged so it can be seen; labels show the true size and distance.",
        ],
    )


def _shortlisted_passes(primary, cat: Catalog, shortlist: perception.ScreeningShortlist, w: Dict[str, float]) -> List[str]:
    """Secondaries of the passes the shortlist screening finds, closest first: the only catalog objects
    the full-catalog scenario precomputes trajectories for (the browser draws the rest as a point cloud)."""
    s = get_settings()
    ids = set(shortlist.object_ids)
    result = screening.screen(primary, [o for o in cat.others(primary.object_id) if o.object_id in ids],
                              w["start_unix"], w["end_unix"], screening_radius_km=s.screening_radius_km,
                              coarse_step_s=s.screening_coarse_step_s, altitude_margin_km=s.altitude_filter_margin_km,
                              co_orbital_min_speed_kms=s.co_orbital_min_relative_speed_kms,
                              numerical_step_s=s.planner_numerical_step_s, apply_altitude_filter=False)
    return list(dict.fromkeys(c.secondary_id for c in result.conjunctions))


def build_real(live: bool = False) -> Scenario:
    cat = real.build_live_catalog() if live else (real.load_full_catalog() or real.load_fixture_catalog())
    w = real.scenario_window(cat)
    real.flag_stale_records(cat, w["start_unix"])
    primary = cat.require(real.PRIMARY_ID)
    shortlist = perception.screening_shortlist(primary, cat.others(real.PRIMARY_ID), w["start_unix"])
    if shortlist:
        rendered = [real.PRIMARY_ID] + _shortlisted_passes(primary, cat, shortlist, w)
    else:
        # Render the primary plus the objects closest to it in altitude band (bounded for browser performance).
        others = sorted(cat.others(real.PRIMARY_ID),
                        key=lambda o: abs(0.5 * ((o.perigee_alt_km or 0) + (o.apogee_alt_km or 0)) -
                                          0.5 * ((primary.perigee_alt_km or 0) + (primary.apogee_alt_km or 0))))
        rendered = [real.PRIMARY_ID] + [o.object_id for o in others[:80]]
    src = cat.source_info
    tracked = len(perception.valid_others(primary, cat.values()))
    if shortlist:
        shortlist_note = [f"Full catalog: {tracked:,} tracked objects. The ML model scores them all; physics screening, "
                          f"secondary checks and perception use one fixed shortlist of {len(shortlist.object_ids):,} "
                          f"objects (the model's top {shortlist.ml_top_k} plus every object within "
                          f"{shortlist.band_margin_km:g} km of the station's altitude band)."]
    elif tracked > get_settings().perception_full_screen_max_objects:
        shortlist_note = [f"No perception model could be loaded: every one of the {tracked:,} tracked objects is "
                          f"physics-screened on each request (slow), and the ML funnel is unavailable."]
    else:
        shortlist_note = []
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
        ] + shortlist_note,
        screening_shortlist=shortlist,
    )


BUILDERS: Dict[str, Callable[[], Scenario]] = {
    synthetic.SCENARIO_ID: build_synthetic,
    synthetic.SANDBOX_SCENARIO_ID: build_sandbox,
    real.SCENARIO_ID: build_real,
}


def list_scenarios() -> List[Dict[str, Any]]:
    return [
        {"scenario_id": synthetic.SCENARIO_ID, "name": "Scripted conjunction (synthetic)", "kind": "synthetic"},
        {"scenario_id": real.SCENARIO_ID, "name": "ISS vs. cataloged objects (real GP data)", "kind": "real"},
        {"scenario_id": synthetic.SANDBOX_SCENARIO_ID, "name": "Sandbox: spawn junk, autopilot dodges", "kind": "sandbox"},
    ]


def build_scenario(scenario_id: str, live: bool = False) -> Scenario:
    if scenario_id == real.SCENARIO_ID:
        return build_real(live=live)
    builder = BUILDERS.get(scenario_id)
    if builder is None:
        raise KeyError(f"unknown scenario '{scenario_id}'")
    return builder()
