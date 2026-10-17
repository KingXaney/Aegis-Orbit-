"""Secondary screening of a maneuvered trajectory against the catalog.

The post-burn primary (two-body + J2 from the burn state) is screened against
every catalog object from the burn time to the end of the window. The result
lists newly introduced close approaches, changes to the previously known
conjunctions, and whether the screening was complete. A maneuver is never
declared safe merely because it clears the original object.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

from ..config import Settings, get_settings
from ..data.catalog import OrbitalObject
from .collision_probability import POLICY_PROVIDED_ONLY, compute_pc_for_conjunction
from .maneuver_planner import ManeuverCandidate, maneuvered_primary
from .screening import Conjunction, screen
from .threat import ORDER, evaluate_threat_state, meets_mitigation_target
from .time_utils import iso

MATCH_WINDOW_S = 600.0


def check_secondary(cand: ManeuverCandidate, primary: OrbitalObject, objects: Sequence[OrbitalObject],
                    window_end_unix: float, baseline: Sequence[Conjunction], settings: Optional[Settings] = None,
                    pc_policy: str = POLICY_PROVIDED_ONLY) -> Dict[str, Any]:
    s = settings or get_settings()
    by_id = {o.object_id: o for o in objects}
    mp = maneuvered_primary(primary, cand)
    result = screen(mp, objects, cand.burn_time_unix, window_end_unix, screening_radius_km=s.screening_radius_km,
                    coarse_step_s=s.screening_coarse_step_s, altitude_margin_km=s.altitude_filter_margin_km,
                    co_orbital_min_speed_kms=s.co_orbital_min_relative_speed_kms,
                    numerical_step_s=s.planner_numerical_step_s)
    post: List[Conjunction] = result.conjunctions
    for c in post:
        sec = by_id.get(c.secondary_id)
        if sec is not None:
            c.pc = compute_pc_for_conjunction(c, mp, sec, pc_policy)
            c.threat_state, c.threat_rationale = evaluate_threat_state(c.miss_distance_km, c.pc, s)

    relevant_baseline = [b for b in baseline if b.tca_unix >= cand.burn_time_unix]
    matched_post = set()
    changes: List[Dict[str, Any]] = []
    for b in relevant_baseline:
        match = None
        for c in post:
            if c.secondary_id == b.secondary_id and abs(c.tca_unix - b.tca_unix) <= MATCH_WINDOW_S:
                match = c
                break
        if match is not None:
            matched_post.add(match.conjunction_id)
            changes.append({
                "conjunction_id": b.conjunction_id, "secondary_id": b.secondary_id,
                "before_miss_km": float(b.miss_distance_km), "after_miss_km": float(match.miss_distance_km),
                "before_tca": iso(b.tca_unix), "after_tca": iso(match.tca_unix),
                "before_state": b.threat_state, "after_state": match.threat_state,
                "after_pc": match.pc.to_dict() if match.pc else None,
                "status": "STILL_WITHIN_SCREENING_RADIUS",
            })
        else:
            changes.append({
                "conjunction_id": b.conjunction_id, "secondary_id": b.secondary_id,
                "before_miss_km": float(b.miss_distance_km), "after_miss_km": None,
                "before_tca": iso(b.tca_unix), "after_tca": None,
                "before_state": b.threat_state, "after_state": "NORMAL", "after_pc": None,
                "status": f"CLEARED_BEYOND_{s.screening_radius_km:g}_KM",
            })
    new = [c for c in post if c.conjunction_id not in matched_post]
    worst_new = max((ORDER.index(c.threat_state) for c in new), default=-1)
    # The original encounter after the maneuver (from the planner's own refinement)
    original_ok, original_basis = meets_mitigation_target(cand.post_miss_distance_km, cand.post_pc, s)
    limitations = [f"catalog limited to {len(objects)} objects; objects outside it are not screened"]
    if not result.stats["complete"]:
        limitations.append("some catalog objects could not be propagated")
    complete = result.stats["complete"]
    # A failing verdict must never be masked by an incomplete screen.
    if worst_new >= ORDER.index("UNVERIFIED") or not original_ok:
        status = "FAIL"
    elif not complete:
        status = "LIMITED"
    else:
        status = "PASS"
    return {
        "maneuver_id": cand.maneuver_id,
        "screened_from": iso(cand.burn_time_unix),
        "screened_to": iso(window_end_unix),
        "primary_model": mp.position_basis,
        "new_conjunctions": [c.to_dict() for c in new],
        "changed_conjunctions": changes,
        "original_encounter": {"post_miss_km": float(cand.post_miss_distance_km), "meets_target": bool(original_ok),
                               "target_basis": original_basis, "post_threat_state": cand.post_threat_state},
        "worst_new_state": ORDER[worst_new] if worst_new >= 0 else "NORMAL",
        "complete": complete,
        "limitations": limitations,
        "validation_status": status,
        "stats": result.stats,
        "co_orbital": result.co_orbital,
    }
