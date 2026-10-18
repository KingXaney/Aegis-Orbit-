"""Drill threat for the real-data scenario.

Real data rarely puts anything inside the critical radius (the 2026-10-17 snapshot's closest pass to the
ISS is 6.7 km), so the operator flow (alert -> plan -> approve, or stay on course) would never run. A drill
injects one clearly labelled synthetic object, built the way the sandbox builds its junk: defined at its
closest approach to the station (the station's state there plus a designed miss vector, velocity rotated by
a crossing angle) and back-propagated to the injection time with the two-body + J2 model. It is named,
badged and disclaimed as a drill everywhere it appears; resetting the scenario removes it.
"""
from __future__ import annotations

from typing import Any, Dict

from ..config import get_settings
from ..data.catalog import OrbitalObject
from ..data.spacecraft import DEBRIS_FRAGMENT, SpacecraftDesign
from ..physics.frames import osculating_elements
from ..physics.propagation import MODEL_NUMERICAL, anchored
from ..physics.time_utils import from_unix, iso
from . import service
from .sandbox import construct_encounter
from .session import SimulationSession

DRILL_ID = "DRILL-1"
DRILL_NAME = "DRILL-1 (injected test threat)"
LEAD_ORBITS = 2.25  # the pass comes this many station orbits after injection: room for 0.5-2 orbit burn leads
MISS_HORIZONTAL_KM = 0.35
MISS_RADIAL_KM = 0.05
CROSSING_DEG = 65.0
# x circular speed at the pass. At exactly 1 the drill shares the station's period and meets it again every
# orbit (23 passes inside 25 km in the 24 h window); real crossing debris drifts, and so does this.
SPEED_FACTOR = 0.985
END_MARGIN_S = 900.0  # the pass and its post-burn check must fit inside the window
DISCLAIMER = (f"{DRILL_ID} is an injected test threat, not a catalogued object: a synthetic fragment built to pass "
              f"{MISS_HORIZONTAL_KM * 1000:.0f} m from the station so the operator flow can be exercised on real data.")
DESIGN = SpacecraftDesign(DEBRIS_FRAGMENT, "Drill fragment", 0.9, 0.5, 0.3, "SCENARIO_DEFINITION", "drill definition")


def inject(sess: SimulationSession, now_unix: float) -> Dict[str, Any]:
    settings = get_settings()
    scen = sess.scenario
    with sess.lock:
        if scen.kind != "real":
            raise service.Conflict("drills run only in the real-data scenario")
        if DRILL_ID in scen.catalog:
            raise service.Conflict("a drill is already running in this session; reset the scenario to clear it")
        if now_unix < scen.start_unix:
            raise service.BadRequest(f"now {iso(now_unix)} is before the scenario window starts")
        primary = scen.catalog.require(scen.primary_id)
        t_tca = now_unix + LEAD_ORBITS * (primary.period_s or 5560.0)
        latest = scen.end_unix - END_MARGIN_S
        if t_tca > latest:
            raise service.Conflict(f"too late in the window for a drill: its pass would come after {iso(latest)}")
        r, v, designed = construct_encounter(primary, now_unix, t_tca, MISS_HORIZONTAL_KM, MISS_RADIAL_KM, CROSSING_DEG,
                                             speed_factor=SPEED_FACTOR, step_s=settings.planner_numerical_step_s)
        el = osculating_elements(r, v)
        obj = OrbitalObject(
            object_id=DRILL_ID, name=DRILL_NAME, category="DEBRIS", category_basis="DRILL_DEFINITION",
            source="drill", source_detail=f"injected {iso(now_unix)}: a test threat, not a catalogued object",
            epoch=from_unix(now_unix), propagation_model=MODEL_NUMERICAL, position_basis="DRILL_INJECTED",
            state_epoch_unix=float(now_unix), r0_teme_km=r.copy(), v0_teme_kms=v.copy(),
            radius_m=0.5, radius_basis="SCENARIO_DEFINITION",
            perigee_alt_km=el["perigee_alt_km"], apogee_alt_km=el["apogee_alt_km"], period_s=el["period_s"],
            inclination_deg=el["inclination_deg"], design_override=DESIGN, spawned_at_unix=float(now_unix),
            spawn={"kind": "drill", **designed},
        )
        obj = anchored(obj, sess.anchor_epoch_unix, settings.planner_numerical_step_s)
        scen.catalog.add(obj)
        scen.rendered_object_ids.append(DRILL_ID)
        scen.highlight_object_ids.append(DRILL_ID)
        if scen.screening_shortlist:
            scen.screening_shortlist.add(DRILL_ID)
        scen.disclaimers.append(DISCLAIMER)
        sess.invalidate_perception()
        sess.add_event("DRILL_INJECTED", f"{DRILL_NAME} injected: designed pass {designed['miss_km']:.2f} km at "
                                         f"{designed['tca']}", at_unix=now_unix, object_id=DRILL_ID)
    # the realistic scenario screens its whole window, whatever the session clock says
    screening = service.run_screening(sess, start=iso(scen.start_unix), end=iso(scen.end_unix), touch_clock=False)
    return {"scenario_id": sess.scenario_id, "now": iso(now_unix), "now_unix": float(now_unix), "object": obj.summary(),
            "designed": designed, "screening": screening}
