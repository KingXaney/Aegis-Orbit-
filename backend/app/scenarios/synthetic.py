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
4. A few background objects populate the scene at other altitudes/planes.

Covariances and hard-body radii are scenario definitions and are labelled
ASSUMED_ILLUSTRATIVE / SCENARIO_DEFINITION everywhere they appear.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, List

import numpy as np

from ..data.catalog import Catalog, OrbitalObject
from ..data.spacecraft import DEBRIS_FRAGMENT, KNOWN_DESIGNS_BY_NORAD, SpacecraftDesign
from ..physics.frames import circular_state, osculating_elements, rtn_basis
from ..physics.propagation import MODEL_NUMERICAL, propagate_states
from ..physics.time_utils import iso, to_unix

SCENARIO_ID = "synthetic-conjunction"
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


def _rotate_about(vec: np.ndarray, axis: np.ndarray, angle_rad: float) -> np.ndarray:
    axis = axis / np.linalg.norm(axis)
    c, s = np.cos(angle_rad), np.sin(angle_rad)
    return vec * c + np.cross(axis, vec) * s + axis * np.dot(axis, vec) * (1.0 - c)


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


def build_synthetic_catalog() -> Catalog:
    tca_unix = T0_UNIX + TCA_OFFSET_S
    # 1. primary at T0 and at TCA
    r_p0, v_p0 = circular_state(R_EARTH_KM + PRIMARY_ALT_KM, PRIMARY_INC_DEG, PRIMARY_RAAN_DEG, PRIMARY_ARG_LAT_DEG)
    y0 = np.concatenate([r_p0, v_p0])[None, :]
    y_tca = propagate_states(y0, T0_UNIX, np.array([tca_unix]), STEP_S)[0, 0]
    r_pt, v_pt = y_tca[:3], y_tca[3:]

    # 2. secondary defined at TCA
    basis = rtn_basis(r_pt, v_pt)  # columns R, T, N
    R = basis[:, 0]
    v_dir = _rotate_about(v_pt / np.linalg.norm(v_pt), R, np.radians(CROSSING_ANGLE_DEG))
    v_rel_dir = v_dir * np.linalg.norm(v_pt) - v_pt
    v_rel_dir /= np.linalg.norm(v_rel_dir)
    horizontal = np.cross(R, v_rel_dir)  # in the local horizontal plane, perpendicular to the relative velocity
    horizontal /= np.linalg.norm(horizontal)
    r_st = r_pt + MISS_HORIZONTAL_KM * horizontal + MISS_RADIAL_KM * R
    v_st = v_dir * np.sqrt(398600.4418 / np.linalg.norm(r_st))

    # 3. back-propagate the secondary to T0
    y_s0 = propagate_states(np.concatenate([r_st, v_st])[None, :], tca_unix, np.array([T0_UNIX]), STEP_S)[0, 0]

    primary = _numerical_object(PRIMARY_ID, "GPM Core Observatory (synthetic state)", "PAYLOAD", r_p0, v_p0, T0_UNIX,
                                radius_m=7.5, sigmas_rtn_m=(60.0, 200.0, 60.0), position_basis="SYNTHETIC_STATE")
    primary.design_override = PRIMARY_DESIGN
    secondary = _numerical_object(SECONDARY_ID, "DEB-2047 (synthetic debris)", "DEBRIS", y_s0[:3], y_s0[3:], T0_UNIX,
                                  radius_m=2.5, sigmas_rtn_m=(120.0, 250.0, 120.0), position_basis="SYNTHETIC_STATE")
    secondary.design_override = SECONDARY_DESIGN

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

    cat = Catalog([primary, secondary] + background, source_info={
        "kind": "synthetic", "scenario_id": SCENARIO_ID, "epoch": iso(T0),
        "designed_tca": iso(tca_unix), "designed_miss_km": float(np.hypot(MISS_HORIZONTAL_KM, MISS_RADIAL_KM)),
        "crossing_angle_deg": CROSSING_ANGLE_DEG,
        "note": "States are generated deterministically; the secondary is defined at the designed TCA and "
                "back-propagated with the same two-body + J2 model used for screening.",
    })
    return cat


def scenario_window() -> Dict[str, float]:
    return {"start_unix": T0_UNIX, "end_unix": T0_UNIX + WINDOW_HOURS * 3600.0}
