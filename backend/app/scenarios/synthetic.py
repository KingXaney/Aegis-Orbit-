"""Deterministic synthetic collision-avoidance scenario.

Construction (all constants, no randomness, so every reset is identical):

1. The primary, a synthetic-state stand-in for NASA's GPM Core Observatory
   (which flies at ~407 km, 65 deg and maintains its orbit with hydrazine
   thrusters), starts on a circular 407 km, 65 deg orbit at T0 and
   is propagated with the two-body + J2 model to the designed encounter time
   TCA = T0 + 3 h. Its state there is P*.
2. The secondary debris object is *defined at TCA*: its position is P* plus a
   designed miss vector (0.35 km horizontal, 0.05 km radial) and its velocity
   is the primary's velocity rotated 65 deg about the local radial axis, so the
   two orbits cross at high relative speed (~8.2 km/s). (At 60 deg in GPM's orbit
   the recommended burn nudged a benign repeat pass of the same debris inside the
   screening radius; 65 deg keeps the scenario's "no new conjunctions" property.)
3. That TCA state is propagated **backwards** with the same model to T0, which
   becomes the secondary's initial state. Forward propagation therefore
   reproduces the encounter exactly up to integrator error (sub-metre).
4. Three more passes make Scenario B a run of encounters (STAGED_PASSES), built the same way: a
   fragment that passes 12 km away at T0 + 1.5 h (inside the screening radius, so it is detected,
   but far outside the mitigation target), and two that come almost head-on later in the window.
   Head-on, the along-track drift an earlier dodge causes barely moves a pass in its encounter
   plane, and each of those two passes meets the primary a whole number of orbits after the
   previous recommended burn, when that burn's radial excursion is back near zero. So the
   operator's flow (dodge each critical pass in turn, earliest first, with the planner's
   recommendation) meets three critical passes; tests/test_scenario_b.py runs it.
5. A few background objects populate the scene at other altitudes/planes.

Covariances and hard-body radii are scenario definitions and are labelled
ASSUMED_ILLUSTRATIVE / SCENARIO_DEFINITION everywhere they appear.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import numpy as np

from ..data.catalog import Catalog, OrbitalObject
from ..data.spacecraft import DEBRIS_FRAGMENT, KNOWN_DESIGNS_BY_NORAD, SpacecraftDesign
from ..physics.frames import circular_state, osculating_elements, rotate_about, rtn_basis
from ..physics.propagation import MODEL_NUMERICAL, propagate_states
from ..physics.time_utils import iso, to_unix

SCENARIO_ID = "synthetic-conjunction"
SANDBOX_SCENARIO_ID = "sandbox"  # the same primary and background objects, no staged pass: junk is spawned live
T0 = datetime(2026, 10, 17, 0, 0, 0, tzinfo=timezone.utc)
T0_UNIX = to_unix(T0)
WINDOW_HOURS = 6.0
TCA_OFFSET_S = 3.0 * 3600.0
PRIMARY_ID = "SYN-GPM"
SECONDARY_ID = "SYN-DEB-2047"

PRIMARY_ALT_KM = 407.0
PRIMARY_INC_DEG = 65.0
PRIMARY_RAAN_DEG = 40.0
PRIMARY_ARG_LAT_DEG = 15.0
CROSSING_ANGLE_DEG = 65.0
MISS_HORIZONTAL_KM = 0.35
MISS_RADIAL_KM = 0.05
STEP_S = 10.0

R_EARTH_KM = 6378.137

# The primary uses GPM's published design (NORAD 39574). The secondary's envelope (in-track x
# cross-track x radial, metres) is chosen to fit inside its hard-body radius.
PRIMARY_DESIGN = KNOWN_DESIGNS_BY_NORAD[39574]
SECONDARY_DESIGN = SpacecraftDesign(
    design_id=DEBRIS_FRAGMENT, label="DEB-2047 structural fragment",
    length_m=3.6, width_m=1.8, height_m=0.5, basis="SCENARIO_DEFINITION",
    reference="synthetic scenario definition",
)


@dataclass(frozen=True)
class StagedPass:
    """A debris object defined at its designed closest approach to the primary (steps 2-3 above)."""
    object_id: str
    name: str
    category: str
    tca_offset_s: float
    crossing_angle_deg: float  # the object's velocity is the primary's rotated by this about the local radial
    miss_horizontal_km: float  # in the local horizontal plane, perpendicular to the relative velocity
    miss_radial_km: float
    radius_m: float
    sigmas_rtn_m: Tuple[float, float, float]
    design: Optional[SpacecraftDesign] = None


# Scenario B's passes in time order. The TCAs of DEB-4410 and R/B-3307 are tuned to the planner's
# recommended burns for the passes before them (T0 + 0.68 h and + 1.45 h, with leads of 1.5 orbits).
# Their misses are tuned so that, at every step of the run, the next critical pass in time is also the
# closest (screening ranks by miss distance, and the agent and the UI start from the top of that list);
# their wider illustrative covariances keep them critical at those misses.
STAGED_PASSES: Tuple[StagedPass, ...] = (
    StagedPass("SYN-DEB-1188", "FRAGMENT-1188 (synthetic debris)", "DEBRIS", 1.5 * 3600.0, 40.0, 12.0, 0.0,
               1.0, (120.0, 250.0, 120.0)),
    StagedPass(SECONDARY_ID, "DEB-2047 (synthetic debris)", "DEBRIS", TCA_OFFSET_S, CROSSING_ANGLE_DEG,
               MISS_HORIZONTAL_KM, MISS_RADIAL_KM, 2.5, (120.0, 250.0, 120.0), SECONDARY_DESIGN),
    StagedPass("SYN-DEB-4410", "DEB-4410 (synthetic debris)", "DEBRIS", 13581.0, 176.0, 0.35, 0.10,
               3.0, (260.0, 300.0, 260.0)),
    StagedPass("SYN-RB-3307", "R/B-3307 (synthetic rocket body)", "ROCKET_BODY", 16353.0, 179.5, 0.47, -0.25,
               4.0, (260.0, 300.0, 260.0)),
)
# the passes that need a maneuver when nothing has been dodged yet
CRITICAL_STAGED_IDS: Tuple[str, ...] = (SECONDARY_ID, "SYN-DEB-4410", "SYN-RB-3307")


_rotate_about = rotate_about  # kept for readers of this module; the sandbox shares the helper


def _numerical_object(object_id: str, name: str, category: str, r0: np.ndarray, v0: np.ndarray,
                      t0_unix: float, radius_m: float, sigmas_rtn_m, position_basis: str) -> OrbitalObject:
    el = osculating_elements(r0, v0)
    cov = np.diag([s * s for s in sigmas_rtn_m]) if sigmas_rtn_m is not None else None
    return OrbitalObject(
        object_id=object_id, name=name, category=category, category_basis="SCENARIO_DEFINITION",
        source="synthetic", source_detail=SCENARIO_ID, epoch=datetime.fromtimestamp(t0_unix, tz=timezone.utc),
        retrieved_at=None, propagation_model=MODEL_NUMERICAL, position_basis=position_basis,
        state_epoch_unix=float(t0_unix), r0_teme_km=np.asarray(r0, float), v0_teme_kms=np.asarray(v0, float),
        radius_m=radius_m, radius_basis="SCENARIO_DEFINITION", covariance_rtn_m2=cov,
        covariance_source="ASSUMED_ILLUSTRATIVE" if cov is not None else "UNAVAILABLE",
        perigee_alt_km=el["perigee_alt_km"], apogee_alt_km=el["apogee_alt_km"], period_s=el["period_s"],
        inclination_deg=el["inclination_deg"],
    )


def _staged_object(p: StagedPass, y0: np.ndarray) -> OrbitalObject:
    tca_unix = T0_UNIX + p.tca_offset_s
    # 1. the primary at this pass's TCA
    y_tca = propagate_states(y0, T0_UNIX, np.array([tca_unix]), STEP_S)[0, 0]
    r_pt, v_pt = y_tca[:3], y_tca[3:]

    # 2. the object defined at TCA
    basis = rtn_basis(r_pt, v_pt)  # columns R, T, N
    R = basis[:, 0]
    v_dir = _rotate_about(v_pt / np.linalg.norm(v_pt), R, np.radians(p.crossing_angle_deg))
    v_rel_dir = v_dir * np.linalg.norm(v_pt) - v_pt
    v_rel_dir /= np.linalg.norm(v_rel_dir)
    horizontal = np.cross(R, v_rel_dir)  # in the local horizontal plane, perpendicular to the relative velocity
    horizontal /= np.linalg.norm(horizontal)
    r_st = r_pt + p.miss_horizontal_km * horizontal + p.miss_radial_km * R
    v_st = v_dir * np.sqrt(398600.4418 / np.linalg.norm(r_st))

    # 3. back-propagated to T0
    y_s0 = propagate_states(np.concatenate([r_st, v_st])[None, :], tca_unix, np.array([T0_UNIX]), STEP_S)[0, 0]
    obj = _numerical_object(p.object_id, p.name, p.category, y_s0[:3], y_s0[3:], T0_UNIX, radius_m=p.radius_m,
                            sigmas_rtn_m=p.sigmas_rtn_m, position_basis="SYNTHETIC_STATE")
    if p.design is not None:
        obj.design_override = p.design
    return obj


def build_synthetic_catalog(include_debris: bool = True) -> Catalog:
    tca_unix = T0_UNIX + TCA_OFFSET_S
    r_p0, v_p0 = circular_state(R_EARTH_KM + PRIMARY_ALT_KM, PRIMARY_INC_DEG, PRIMARY_RAAN_DEG, PRIMARY_ARG_LAT_DEG)
    y0 = np.concatenate([r_p0, v_p0])[None, :]
    primary = _numerical_object(PRIMARY_ID, "GPM Core Observatory (synthetic state)", "PAYLOAD", r_p0, v_p0, T0_UNIX,
                                radius_m=7.5, sigmas_rtn_m=(60.0, 200.0, 60.0), position_basis="SYNTHETIC_STATE")
    primary.design_override = PRIMARY_DESIGN

    # 4. background objects (non-threatening by design; verified by the scenario tests)
    background_defs = [
        ("SYN-SAT-A", "ORBITER-A (synthetic payload)", "PAYLOAD", 545.0, 97.6, 120.0, 200.0, 3.0),
        ("SYN-RB-7", "UPPER STAGE R/B (synthetic)", "ROCKET_BODY", 610.0, 63.4, 300.0, 80.0, 4.0),
        ("SYN-DEB-311", "FRAGMENT-311 (synthetic debris)", "DEBRIS", 480.0, 86.4, 210.0, 330.0, 0.5),
        ("SYN-SAT-C", "RELAY-C (synthetic payload)", "PAYLOAD", 400.0, 28.5, 10.0, 140.0, 2.0),
        ("SYN-DEB-902", "FRAGMENT-902 (synthetic debris)", "DEBRIS", 470.0, 51.6, 225.0, 60.0, 0.5),
    ]
    background: List[OrbitalObject] = []
    for oid, name, cat, alt, inc, raan, arglat, radius in background_defs:
        r, v = circular_state(R_EARTH_KM + alt, inc, raan, arglat)
        background.append(_numerical_object(oid, name, cat, r, v, T0_UNIX, radius_m=radius,
                                            sigmas_rtn_m=None, position_basis="SYNTHETIC_STATE"))

    if not include_debris:
        return Catalog([primary] + background, source_info={
            "kind": "sandbox", "scenario_id": SANDBOX_SCENARIO_ID, "epoch": iso(T0),
            "note": "States are generated deterministically; no pass is staged. Junk spawned in the sandbox is "
                    "defined at its designed closest approach and back-propagated with the same two-body + J2 "
                    "model used for screening.",
        })
    staged = [_staged_object(p, y0) for p in STAGED_PASSES]
    cat = Catalog([primary] + staged + background, source_info={
        "kind": "synthetic", "scenario_id": SCENARIO_ID, "epoch": iso(T0),
        "designed_tca": iso(tca_unix), "designed_miss_km": float(np.hypot(MISS_HORIZONTAL_KM, MISS_RADIAL_KM)),
        "crossing_angle_deg": CROSSING_ANGLE_DEG,
        "staged_passes": [{"object_id": p.object_id, "designed_tca": iso(T0_UNIX + p.tca_offset_s),
                           "designed_miss_km": float(np.hypot(p.miss_horizontal_km, p.miss_radial_km)),
                           "crossing_angle_deg": p.crossing_angle_deg} for p in STAGED_PASSES],
        "note": "States are generated deterministically; each staged object is defined at its designed TCA and "
                "back-propagated with the same two-body + J2 model used for screening.",
    })
    return cat


def build_sandbox_catalog() -> Catalog:
    return build_synthetic_catalog(include_debris=False)


def scenario_window() -> Dict[str, float]:
    return {"start_unix": T0_UNIX, "end_unix": T0_UNIX + WINDOW_HOURS * 3600.0}
