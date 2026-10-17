"""Service layer shared by the REST routes and the agent tools.

Every function operates on a SimulationSession and returns plain dictionaries
shaped like the Pydantic response models, so the agent can call the physics
engine without going through HTTP.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from ..config import get_settings
from ..data.catalog import OrbitalObject
from ..physics import collision_probability as cp
from ..physics import maneuver_planner as mp
from ..physics import secondary_screening as ss
from ..physics import screening
from ..perception.model import load_risk_model
from ..perception.perception import perceive
from ..physics.frames import ecef_to_geodetic, osculating_elements, teme_to_ecef
from ..physics.propagation import propagate
from ..physics.threat import ORDER, evaluate_threat_state, meets_mitigation_target, thresholds_summary, worst_state
from ..physics.time_utils import from_unix, iso, parse_iso, time_grid, to_unix
from .session import SimulationSession

MAX_TRAJECTORY_SAMPLES = 20000


class NotFound(KeyError):
    pass


class BadRequest(ValueError):
    pass


class Conflict(RuntimeError):
    pass


# --------------------------------------------------------------------------
# scenario / objects
# --------------------------------------------------------------------------

def scenario_detail(sess: SimulationSession) -> Dict[str, Any]:
    d = sess.scenario.to_dict()
    d["thresholds"] = thresholds_summary()
    d["simulation"] = sess.state_summary()
    return d


def list_objects(sess: SimulationSession) -> Dict[str, Any]:
    return {
        "scenario_id": sess.scenario_id,
        "primary_id": sess.scenario.primary_id,
        "objects": [o.summary() for o in sess.scenario.catalog.values()],
        "rejected_records": sess.scenario.catalog.rejected[:50],
    }


def _parse_time(value: Optional[str], default_unix: float) -> float:
    if value is None or value == "":
        return float(default_unix)
    try:
        return to_unix(parse_iso(value))
    except ValueError as exc:
        raise BadRequest(f"invalid ISO 8601 timestamp '{value}': {exc}") from exc


def _require_object(sess: SimulationSession, object_id: str) -> OrbitalObject:
    obj = sess.scenario.catalog.get(object_id)
    if obj is None:
        raise NotFound(f"object '{object_id}' is not part of scenario '{sess.scenario_id}'")
    return obj


def object_detail(sess: SimulationSession, object_id: str, at: Optional[str] = None) -> Dict[str, Any]:
    obj = _require_object(sess, object_id)
    t = _parse_time(at, sess.scenario.start_unix)
    d = obj.summary()
    res = propagate(obj, np.array([t]), get_settings().planner_numerical_step_s)
    if res.status == "OK":
        r, v = res.positions_km[0], res.velocities_kms[0]
        ecef = teme_to_ecef(r, t)
        d["state"] = {
            "at": iso(t), "frame": "TEME", "units": {"position": "km", "velocity": "km/s"},
            "position_km": [float(x) for x in r], "velocity_kms": [float(x) for x in v],
            "geocentric_altitude_km": float(np.linalg.norm(r) - 6378.137),
            "geodetic": ecef_to_geodetic(ecef),
            "osculating_elements": osculating_elements(r, v),
            "status": "OK", "messages": [],
        }
    else:
        d["state"] = {"at": iso(t), "frame": "TEME", "units": {"position": "km", "velocity": "km/s"},
                      "position_km": [], "velocity_kms": [], "geocentric_altitude_km": float("nan"),
                      "geodetic": {}, "osculating_elements": {}, "status": res.status, "messages": res.messages}
    if obj.tle_line1:
        d["tle"] = {"line1": obj.tle_line1, "line2": obj.tle_line2 or ""}
    return d


# --------------------------------------------------------------------------
# trajectories
# --------------------------------------------------------------------------

def _round(a: np.ndarray, nd: int) -> List[List[float]]:
    a = np.asarray(a, dtype=float)
    out = np.round(a, nd)
    return [[(None if np.isnan(x) else float(x)) for x in row] for row in out]


def trajectory(sess: SimulationSession, object_id: str, start: Optional[str] = None, end: Optional[str] = None,
               step_s: float = 60.0, maneuver_id: Optional[str] = None) -> Dict[str, Any]:
    obj = _require_object(sess, object_id)
    t0 = _parse_time(start, sess.scenario.start_unix)
    t1 = _parse_time(end, sess.scenario.end_unix)
    if t1 <= t0:
        raise BadRequest("end must be after start")
    if (t1 - t0) / step_s > MAX_TRAJECTORY_SAMPLES:
        raise BadRequest(f"too many samples requested (max {MAX_TRAJECTORY_SAMPLES}); increase step_s")
    settings = get_settings()
    times = time_grid(t0, t1, step_s)
    segments: List[Dict[str, Any]] = []
    burn_time = None
    if maneuver_id:
        cand = sess.maneuvers.get(maneuver_id)
        if cand is None:
            raise NotFound(f"maneuver '{maneuver_id}' not found in this session")
        if object_id != sess.scenario.primary_id:
            raise BadRequest("maneuvered trajectories exist only for the primary object")
        tb = float(cand.burn_time_unix)
        burn_time = iso(tb)
        if t0 < tb < t1:
            times = np.unique(np.concatenate([times, [tb]]))
        pre_mask = times < tb
        pre = propagate(obj, times[pre_mask], settings.planner_numerical_step_s) if pre_mask.any() else None
        mobj = mp.maneuvered_primary(obj, cand)
        post = propagate(mobj, times[~pre_mask], settings.planner_numerical_step_s) if (~pre_mask).any() else None
        parts_r, parts_v, codes, msgs = [], [], [], []
        if pre is not None:
            parts_r.append(pre.positions_km); parts_v.append(pre.velocities_kms); codes.append(pre.error_codes); msgs += pre.messages
            segments.append({"start": iso(times[pre_mask][0]), "end": iso(times[pre_mask][-1]), "model": pre.model,
                             "label": "pre-burn (native model)"})
        if post is not None:
            parts_r.append(post.positions_km); parts_v.append(post.velocities_kms); codes.append(post.error_codes); msgs += post.messages
            segments.append({"start": iso(times[~pre_mask][0]), "end": iso(times[~pre_mask][-1]), "model": post.model,
                             "label": f"post-burn ({cand.maneuver_id}, two-body + J2)"})
        r = np.concatenate(parts_r); v = np.concatenate(parts_v); err = np.concatenate(codes)
        status = "OK" if not err.any() else ("FAILED" if err.all() else "PARTIAL")
        model = f"{obj.propagation_model} + NUMERICAL_J2 after burn"
        basis = mobj.position_basis
    else:
        res = propagate(obj, times, settings.planner_numerical_step_s)
        r, v, status, msgs, model, basis = res.positions_km, res.velocities_kms, res.status, res.messages, res.model, obj.position_basis
        segments.append({"start": iso(times[0]), "end": iso(times[-1]), "model": model, "label": "predicted (native model)"})
    return {
        "object_id": object_id, "scenario_id": sess.scenario_id, "frame": "TEME",
        "units": {"position": "km", "velocity": "km/s", "time": "unix seconds (UTC)"},
        "model": model, "position_basis": basis, "source_epoch": iso(obj.epoch) if obj.epoch else None,
        "start": iso(times[0]), "end": iso(times[-1]), "step_s": step_s,
        "times_unix": [float(t) for t in times], "positions_km": _round(r, 3), "velocities_kms": _round(v, 6),
        "status": status, "messages": msgs, "segments": segments, "maneuver_id": maneuver_id, "burn_time": burn_time,
    }


def trajectories(sess: SimulationSession, object_ids: Sequence[str], start: Optional[str], end: Optional[str],
                 step_s: float) -> Dict[str, Any]:
    return {"trajectories": [trajectory(sess, oid, start, end, step_s) for oid in object_ids]}


# --------------------------------------------------------------------------
# screening
# --------------------------------------------------------------------------

def _decorate(sess: SimulationSession, c: screening.Conjunction) -> Dict[str, Any]:
    d = c.to_dict()
    sec = sess.scenario.catalog.get(c.secondary_id)
    d["secondary_name"] = sec.name if sec else None
    d["secondary_category"] = sec.category if sec else None
    return d


def run_screening(sess: SimulationSession, primary_id: Optional[str] = None, start: Optional[str] = None,
                  end: Optional[str] = None, pc_policy: Optional[str] = None,
                  screening_radius_km: Optional[float] = None) -> Dict[str, Any]:
    settings = get_settings()
    scen = sess.scenario
    primary_id = primary_id or scen.primary_id
    primary = _require_object(sess, primary_id)
    policy = pc_policy or scen.pc_policy
    if policy not in (cp.POLICY_PROVIDED_ONLY, cp.POLICY_ILLUSTRATIVE_DEFAULT):
        raise BadRequest(f"unknown pc_policy '{policy}'")
    t0 = _parse_time(start, scen.start_unix)
    t1 = _parse_time(end, scen.end_unix)
    if t1 <= t0:
        raise BadRequest("end must be after start")
    radius = screening_radius_km or settings.screening_radius_km
    try:
        result = screening.screen(primary, scen.catalog.others(primary_id), t0, t1, screening_radius_km=radius,
                                  coarse_step_s=settings.screening_coarse_step_s,
                                  altitude_margin_km=settings.altitude_filter_margin_km,
                                  co_orbital_min_speed_kms=settings.co_orbital_min_relative_speed_kms,
                                  numerical_step_s=settings.planner_numerical_step_s)
    except ValueError as exc:
        raise BadRequest(str(exc)) from exc
    for c in result.conjunctions:
        sec = scen.catalog.require(c.secondary_id)
        c.pc = cp.compute_pc_for_conjunction(c, primary, sec, policy)
        c.threat_state, c.threat_rationale = evaluate_threat_state(c.miss_distance_km, c.pc, settings)
    sess.conjunctions = {c.conjunction_id: c for c in result.conjunctions}
    sess.screening = result.to_dict()
    sess.screening_pc_policy = policy
    sess.invalidate_perception()
    return {
        "scenario_id": sess.scenario_id, "primary_id": primary_id,
        "conjunctions": [_decorate(sess, c) for c in result.conjunctions],
        "stats": result.stats, "co_orbital": result.co_orbital, "propagation_failures": result.propagation_failures,
        "overall_threat_state": sess.overall_threat_state(), "pc_policy": policy, "thresholds": thresholds_summary(settings),
    }


def current_screening(sess: SimulationSession) -> Dict[str, Any]:
    if sess.screening is None:
        raise NotFound("no screening has been run for this scenario yet")
    settings = get_settings()
    return {
        "scenario_id": sess.scenario_id, "primary_id": sess.scenario.primary_id,
        "conjunctions": [_decorate(sess, c) for c in sess.ranked_conjunctions()],
        "stats": sess.screening["stats"], "co_orbital": sess.screening["co_orbital"],
        "propagation_failures": sess.screening["propagation_failures"],
        "overall_threat_state": sess.overall_threat_state(), "pc_policy": sess.screening_pc_policy or sess.scenario.pc_policy,
        "thresholds": thresholds_summary(settings),
    }


def get_plan(sess: SimulationSession, conjunction_id: str) -> Dict[str, Any]:
    plan = sess.plans.get(conjunction_id)
    if plan is None:
        raise NotFound(f"no maneuver plan exists for conjunction '{conjunction_id}' in this session")
    d = plan.to_dict()
    d["scenario_id"] = sess.scenario_id
    return d


def get_conjunction(sess: SimulationSession, conjunction_id: str) -> Dict[str, Any]:
    c = sess.conjunctions.get(conjunction_id)
    if c is None:
        raise NotFound(f"conjunction '{conjunction_id}' not found; run screening first")
    return _decorate(sess, c)


# --------------------------------------------------------------------------
# maneuvers
# --------------------------------------------------------------------------

def plan_for_conjunction(sess: SimulationSession, conjunction_id: str, max_candidates: int = 3,
                         earliest_burn: Optional[str] = None, pc_policy: Optional[str] = None,
                         lead_orbits: Optional[List[float]] = None, dv_magnitudes_mps: Optional[List[float]] = None,
                         directions: Optional[List[str]] = None) -> Dict[str, Any]:
    c = sess.conjunctions.get(conjunction_id)
    if c is None:
        raise NotFound(f"conjunction '{conjunction_id}' not found; run screening first")
    scen = sess.scenario
    primary = scen.catalog.require(c.primary_id)
    secondary = scen.catalog.require(c.secondary_id)
    policy = pc_policy or sess.screening_pc_policy or scen.pc_policy
    earliest = _parse_time(earliest_burn, scen.start_unix) if earliest_burn else None
    try:
        plan = mp.plan_maneuvers(c, primary, secondary, scen.start_unix, earliest_burn_unix=earliest,
                                 settings=get_settings(), pc_policy=policy, max_candidates=max_candidates,
                                 lead_orbits=lead_orbits, dv_magnitudes_mps=dv_magnitudes_mps, directions=directions)
    except ValueError as exc:
        raise BadRequest(str(exc)) from exc
    sess.plans[conjunction_id] = plan
    for cand in plan.candidates:
        sess.maneuvers[cand.maneuver_id] = cand
    d = plan.to_dict()
    d["scenario_id"] = sess.scenario_id
    return d


def get_maneuver(sess: SimulationSession, maneuver_id: str) -> mp.ManeuverCandidate:
    cand = sess.maneuvers.get(maneuver_id)
    if cand is None:
        raise NotFound(f"maneuver '{maneuver_id}' not found; plan maneuvers first")
    return cand


def run_secondary_check(sess: SimulationSession, maneuver_id: str) -> Dict[str, Any]:
    cand = get_maneuver(sess, maneuver_id)
    scen = sess.scenario
    primary = scen.catalog.require(scen.primary_id)
    policy = sess.screening_pc_policy or scen.pc_policy
    result = ss.check_secondary(cand, primary, scen.catalog.others(primary.object_id), scen.end_unix,
                                list(sess.conjunctions.values()), get_settings(), policy)
    result["scenario_id"] = sess.scenario_id
    sess.secondary_checks[maneuver_id] = result
    cand.secondary_check = {
        "validation_status": result["validation_status"], "complete": result["complete"],
        "new_conjunctions": len(result["new_conjunctions"]), "worst_new_state": result["worst_new_state"],
        "original_encounter": result["original_encounter"], "limitations": result["limitations"],
    }
    return result


# --------------------------------------------------------------------------
# human decisions
# --------------------------------------------------------------------------

def approve(sess: SimulationSession, maneuver_id: str) -> Dict[str, Any]:
    cand = get_maneuver(sess, maneuver_id)
    if not cand.feasible:
        raise Conflict(f"maneuver {maneuver_id} is not feasible: {'; '.join(cand.feasibility_reasons)}")
    check = sess.secondary_checks.get(maneuver_id) or run_secondary_check(sess, maneuver_id)
    if check["validation_status"] == "FAIL":
        raise Conflict(f"maneuver {maneuver_id} failed secondary screening "
                       f"(worst new state {check['worst_new_state']}, original encounter meets target: "
                       f"{check['original_encounter']['meets_target']})")
    decision = sess.record_decision("APPROVED", maneuver_id)
    sess.approved_maneuver_id = maneuver_id
    sess.invalidate_perception()
    ok, basis = meets_mitigation_target(cand.post_miss_distance_km, cand.post_pc, get_settings())
    new_states = [c["threat_state"] for c in check["new_conjunctions"]]
    residual = [x["after_state"] for x in check["changed_conjunctions"] if x.get("after_state")]
    others = worst_state([st for st in new_states + residual if st in ORDER] or ["NORMAL"])
    if ok and check["validation_status"] == "PASS" and ORDER.index(others) <= ORDER.index("MONITORING"):
        overall = "MITIGATED"
    else:
        overall = worst_state([cand.post_threat_state, others])
    sess.post_approval = {
        "maneuver_id": maneuver_id, "conjunction_id": cand.conjunction_id,
        "post_miss_distance_km": float(cand.post_miss_distance_km), "post_tca": iso(cand.post_tca_unix),
        "post_pc": cand.post_pc.to_dict() if cand.post_pc else None, "post_threat_state": cand.post_threat_state,
        "meets_target": bool(ok), "target_basis": basis, "secondary_check_status": check["validation_status"],
        "new_conjunctions": len(check["new_conjunctions"]), "overall_threat_state": overall,
        "approved_at": decision["at"],
    }
    return {"decision": decision, "maneuver": cand.to_dict(), "secondary_check": check,
            "simulation": sess.state_summary()}


def reject(sess: SimulationSession, maneuver_id: str, reason: Optional[str] = None) -> Dict[str, Any]:
    cand = get_maneuver(sess, maneuver_id)
    decision = sess.record_decision("REJECTED", maneuver_id, reason)
    if sess.approved_maneuver_id == maneuver_id:
        sess.approved_maneuver_id = None
        sess.post_approval = None
        sess.invalidate_perception()
    return {"decision": decision, "maneuver": cand.to_dict(), "secondary_check": sess.secondary_checks.get(maneuver_id),
            "simulation": sess.state_summary()}


# --------------------------------------------------------------------------
# perception
# --------------------------------------------------------------------------

def perception(sess: SimulationSession, horizon_s: Optional[float] = None, critical_radius_km: Optional[float] = None,
               tracked_radius_km: Optional[float] = None, maneuver_id: Optional[str] = None,
               include_hidden: bool = False, trails: bool = True) -> Dict[str, Any]:
    if maneuver_id and maneuver_id not in sess.maneuvers:
        raise NotFound(f"maneuver '{maneuver_id}' not found in this session")
    try:
        return perceive(sess, horizon_s=horizon_s, critical_radius_km=critical_radius_km,
                        tracked_radius_km=tracked_radius_km, maneuver_id=maneuver_id, include_hidden=include_hidden,
                        trails=trails, settings=get_settings())
    except ValueError as exc:
        raise BadRequest(str(exc)) from exc


def perception_model_info() -> Dict[str, Any]:
    return load_risk_model(get_settings().perception_model_meta_file).info.to_dict()
