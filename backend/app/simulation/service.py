"""Service layer shared by the REST routes and the agent tools.

Every function operates on a SimulationSession and returns plain dictionaries
shaped like the Pydantic response models, so the agent can call the physics
engine without going through HTTP.

Time: the backend has no clock of its own. Clients send ``now``/``start`` with
time-dependent calls; the session remembers the latest one (``clock_unix``) as
the default for calls that omit it, and falls back to the scenario window when
no client ever sent one (the realistic scenario behaves exactly like a fixed
window).
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from ..config import PlannerProfile, get_settings
from ..data.catalog import OrbitalObject
from ..physics import collision_probability as cp
from ..physics import maneuver_planner as mp
from ..physics import secondary_screening as ss
from ..physics import screening
from ..perception.model import load_risk_model
from ..perception.perception import ScreeningShortlist, perceive, valid_others
from ..physics.frames import ecef_to_geodetic, osculating_elements, teme_to_ecef
from ..physics.propagation import MODEL_NUMERICAL, burn_times, original_of, propagate
from ..physics.threat import ORDER, evaluate_threat_state, meets_mitigation_target, thresholds_summary, worst_state
from ..physics.time_utils import iso, parse_iso, time_grid, to_unix
from .session import CommittedBurn, SimulationSession

MAX_TRAJECTORY_SAMPLES = 20000
TRAJECTORY_VARIANTS = ("committed", "original")


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
    """Every object's summary, or, for a shortlisted (full-catalog) scenario, only the primary, the rendered
    objects and the shortlist: 18k summaries are ~19 MB, and the browser draws the rest from catalog_tles."""
    scen = sess.scenario
    objs = objs_all = scen.catalog.values()
    partial = bool(scen.screening_shortlist)
    if partial:
        keep = {scen.primary_id, *scen.rendered_object_ids, *scen.highlight_object_ids,
                *scen.screening_shortlist.object_ids}
        objs = [o for o in objs if o.object_id in keep]
    return {
        "scenario_id": sess.scenario_id,
        "primary_id": scen.primary_id,
        "objects": [o.summary() for o in objs],
        "rejected_records": scen.catalog.rejected[:50],
        "catalog_total": len(valid_others(scen.catalog.require(scen.primary_id), objs_all)),
        "partial": partial,
    }


def catalog_tles(sess: SimulationSession) -> Dict[str, Any]:
    """Compact element rows for every catalogued (TLE) object except the primary: the browser propagates
    them with SGP4 to draw the whole catalog as a point cloud."""
    scen = sess.scenario
    rows = [[o.object_id, o.name.strip(), o.category, o.tle_line1, o.tle_line2] for o in scen.catalog.values()
            if o.object_id != scen.primary_id and o.tle_line1 and o.tle_line2 and o.validation_status != "INVALID"]
    src = scen.catalog.source_info
    return {"scenario_id": sess.scenario_id, "primary_id": scen.primary_id, "count": len(rows),
            "fields": ["object_id", "name", "category", "line1", "line2"], "rows": rows,
            "source": src.get("fixture") or src.get("kind"), "retrieved_at": src.get("retrieved_at")}


def _screening_objects(sess: SimulationSession, primary_id: str) -> Tuple[List[OrbitalObject], Optional[ScreeningShortlist]]:
    """What a screening of ``primary_id`` runs against: the scenario's fixed ML shortlist when it has one
    (full catalog), otherwise every other object. Baseline and post-burn screens use the same set."""
    scen = sess.scenario
    others = scen.catalog.others(primary_id)
    shortlist = scen.screening_shortlist
    if not shortlist or primary_id != scen.primary_id:
        return others, None
    ids = set(shortlist.object_ids)
    return [o for o in others if o.object_id in ids], shortlist


def _shortlist_stats(sess: SimulationSession, primary_id: str, shortlist: Optional[ScreeningShortlist]) -> Dict[str, Any]:
    catalog = sess.scenario.catalog
    return {"catalog_total": len(valid_others(catalog.require(primary_id), catalog.values())),
            "shortlist": shortlist.public() if shortlist else None}


def profile_for(sess: SimulationSession) -> PlannerProfile:
    """The sandbox (synthetic) scenario plans with short leads and larger burns; the real one as before."""
    s = get_settings()
    return s.sandbox_profile() if sess.sandbox else s.default_profile()


def _window_span(sess: SimulationSession) -> float:
    return sess.scenario.end_unix - sess.scenario.start_unix


def _default_start(sess: SimulationSession) -> float:
    return sess.clock_unix if sess.clock_unix is not None else sess.scenario.start_unix


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
    t = _parse_time(at, _default_start(sess))
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


def _arc_segments(obj: OrbitalObject, times: np.ndarray, burns: List[float]) -> List[Dict[str, Any]]:
    """One entry per model arc inside the sampled range (native arc, then one per committed burn)."""
    t0, t1 = float(times[0]), float(times[-1])
    base_model = obj.base_model or obj.propagation_model
    if not burns:
        return [{"start": iso(t0), "end": iso(t1), "model": base_model, "label": "predicted (native model)",
                 "maneuver_id": None}]
    out: List[Dict[str, Any]] = []
    if t0 < burns[0]:
        out.append({"start": iso(t0), "end": iso(min(burns[0], t1)), "model": base_model,
                    "label": "pre-burn (native model)", "maneuver_id": None})
    for k, tb in enumerate(burns):
        start = max(tb, t0)
        end = min(burns[k + 1] if k + 1 < len(burns) else t1, t1)
        if start > t1 or start > end:
            continue
        mid = obj.segments[k].maneuver_id if k < len(obj.segments) else None
        out.append({"start": iso(start), "end": iso(end), "model": MODEL_NUMERICAL,
                    "label": f"post-burn ({mid}, two-body + J2)", "maneuver_id": mid})
    return out


def trajectory(sess: SimulationSession, object_id: str, start: Optional[str] = None, end: Optional[str] = None,
               step_s: float = 60.0, maneuver_id: Optional[str] = None, variant: Optional[str] = None) -> Dict[str, Any]:
    """Sampled TEME trajectory. The primary's default is its *committed* path (burns included);
    ``variant=original`` gives the path without burns; ``maneuver_id`` previews a candidate on top
    of the committed path (or returns the committed path when that burn is already committed)."""
    obj = _require_object(sess, object_id)
    scen = sess.scenario
    t0 = _parse_time(start, scen.start_unix)
    t1 = _parse_time(end, scen.end_unix if not start else t0 + _window_span(sess))
    if t1 <= t0:
        raise BadRequest("end must be after start")
    if (t1 - t0) / step_s > MAX_TRAJECTORY_SAMPLES:
        raise BadRequest(f"too many samples requested (max {MAX_TRAJECTORY_SAMPLES}); increase step_s")
    if variant not in (None, "") and variant not in TRAJECTORY_VARIANTS:
        raise BadRequest(f"variant must be one of {', '.join(TRAJECTORY_VARIANTS)}")
    settings = get_settings()
    cand = None
    kind = "original"
    if variant == "original":
        obj = original_of(obj)
    else:
        if obj.segments:
            kind = "committed"
        if maneuver_id:
            cand = sess.maneuvers.get(maneuver_id)
            if cand is None:
                raise NotFound(f"maneuver '{maneuver_id}' not found in this session")
            if object_id != scen.primary_id:
                raise BadRequest("maneuvered trajectories exist only for the primary object")
            if not sess.is_committed(maneuver_id):
                try:
                    obj = mp.with_burn(obj, cand)
                except ValueError as exc:
                    raise BadRequest(f"candidate {maneuver_id} cannot be previewed on the current trajectory: {exc}") from exc
                kind = "candidate"
    times = time_grid(t0, t1, step_s)
    burns = burn_times(obj)
    inside = [tb for tb in burns if t0 < tb < t1]
    if inside:
        times = np.unique(np.concatenate([times, np.asarray(inside, dtype=float)]))  # the kink is sampled
    res = propagate(obj, times, settings.planner_numerical_step_s)
    r, v, msgs = res.positions_km, res.velocities_kms, list(res.messages)
    if r.shape[0] != len(times):
        r = np.full((len(times), 3), np.nan)
        v = np.full((len(times), 3), np.nan)
    if obj.spawned_at_unix is not None and times[0] < obj.spawned_at_unix - 1e-6:
        hide = times < obj.spawned_at_unix - 1e-6
        r = np.where(hide[:, None], np.nan, r)
        v = np.where(hide[:, None], np.nan, v)
        msgs.append(f"samples before the spawn time {iso(obj.spawned_at_unix)} are omitted")
    burn_time = iso(cand.burn_time_unix) if cand is not None else (iso(burns[0]) if burns else None)
    return {
        "object_id": object_id, "scenario_id": sess.scenario_id, "frame": "TEME",
        "units": {"position": "km", "velocity": "km/s", "time": "unix seconds (UTC)"},
        "model": res.model, "position_basis": obj.position_basis, "source_epoch": iso(obj.epoch) if obj.epoch else None,
        "start": iso(times[0]), "end": iso(times[-1]), "step_s": step_s,
        "times_unix": [float(t) for t in times], "positions_km": _round(r, 3), "velocities_kms": _round(v, 6),
        "status": res.status, "messages": msgs, "segments": _arc_segments(obj, times, burns),
        "maneuver_id": maneuver_id, "burn_time": burn_time,
        "burn_times_unix": [float(b) for b in burns], "variant": kind,
    }


def trajectories(sess: SimulationSession, object_ids: Sequence[str], start: Optional[str], end: Optional[str],
                 step_s: float, variant: Optional[str] = None) -> Dict[str, Any]:
    return {"trajectories": [trajectory(sess, oid, start, end, step_s, variant=variant) for oid in object_ids]}


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
                  screening_radius_km: Optional[float] = None, *, store_window: bool = True,
                  touch_clock: bool = True) -> Dict[str, Any]:
    """Screen the (committed) primary over [start, end]; ``end`` defaults to start + the window length."""
    settings = get_settings()
    scen = sess.scenario
    primary_id = primary_id or scen.primary_id
    primary = _require_object(sess, primary_id)
    policy = pc_policy or scen.pc_policy
    if policy not in (cp.POLICY_PROVIDED_ONLY, cp.POLICY_ILLUSTRATIVE_DEFAULT):
        raise BadRequest(f"unknown pc_policy '{policy}'")
    t0 = _parse_time(start, _default_start(sess))
    t1 = _parse_time(end, t0 + _window_span(sess))
    if t1 <= t0:
        raise BadRequest("end must be after start")
    if start and touch_clock:
        sess.clock_unix = float(t0)
    radius = screening_radius_km or settings.screening_radius_km
    with sess.lock:
        objects, shortlist = _screening_objects(sess, primary_id)
        try:
            result = screening.screen(primary, objects, t0, t1, screening_radius_km=radius,
                                      coarse_step_s=settings.screening_coarse_step_s,
                                      altitude_margin_km=settings.altitude_filter_margin_km,
                                      co_orbital_min_speed_kms=settings.co_orbital_min_relative_speed_kms,
                                      numerical_step_s=settings.planner_numerical_step_s)
        except ValueError as exc:
            raise BadRequest(str(exc)) from exc
        result.stats.update(_shortlist_stats(sess, primary_id, shortlist))
        for c in result.conjunctions:
            sec = scen.catalog.require(c.secondary_id)
            c.pc = cp.compute_pc_for_conjunction(c, primary, sec, policy)
            c.threat_state, c.threat_rationale = evaluate_threat_state(c.miss_distance_km, c.pc, settings)
        sess.conjunctions = {c.conjunction_id: c for c in result.conjunctions}
        sess.screening = result.to_dict()
        sess.screening_pc_policy = policy
        if store_window:
            sess.screening_window = (float(t0), float(t1))
        sess.invalidate_perception()
    return {
        "scenario_id": sess.scenario_id, "primary_id": primary_id,
        "conjunctions": [_decorate(sess, c) for c in result.conjunctions],
        "stats": result.stats, "co_orbital": result.co_orbital, "propagation_failures": result.propagation_failures,
        "overall_threat_state": sess.overall_threat_state(), "pc_policy": policy, "thresholds": thresholds_summary(settings),
    }


def _rescreen(sess: SimulationSession) -> None:
    """Re-screen the session's current window against the (changed) committed path."""
    if not sess.screening_window:
        return
    t0, t1 = sess.screening_window
    run_screening(sess, start=iso(t0), end=iso(t1), pc_policy=sess.screening_pc_policy, store_window=False,
                  touch_clock=False)


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
                         directions: Optional[List[str]] = None, profile: Optional[PlannerProfile] = None) -> Dict[str, Any]:
    c = sess.conjunctions.get(conjunction_id)
    if c is None:
        raise NotFound(f"conjunction '{conjunction_id}' not found; run screening first")
    scen = sess.scenario
    prof = profile or profile_for(sess)
    primary = scen.catalog.require(c.primary_id)
    secondary = scen.catalog.require(c.secondary_id)
    policy = pc_policy or sess.screening_pc_policy or scen.pc_policy
    earliest = _parse_time(earliest_burn, scen.start_unix) if earliest_burn else None
    if earliest is None and sess.clock_unix is not None:
        earliest = sess.clock_unix + prof.earliest_burn_margin_s
    if sess.committed:
        # burns are append-only in time (see maneuver_planner.with_segment)
        floor = sess.committed[-1].burn_time_unix + prof.burn_spacing_s
        earliest = floor if earliest is None else max(earliest, floor)
    with sess.lock:
        try:
            plan = mp.plan_maneuvers(c, primary, secondary, scen.start_unix, earliest_burn_unix=earliest,
                                     settings=get_settings(), pc_policy=policy, max_candidates=max_candidates,
                                     lead_orbits=lead_orbits, dv_magnitudes_mps=dv_magnitudes_mps, directions=directions,
                                     profile=prof)
        except ValueError as exc:
            raise BadRequest(str(exc)) from exc
        sess.plans[conjunction_id] = plan
        for cand in plan.candidates:
            cand.primary_version = sess.primary_version
            sess.maneuvers[cand.maneuver_id] = cand
    d = plan.to_dict()
    d["scenario_id"] = sess.scenario_id
    return d


def get_maneuver(sess: SimulationSession, maneuver_id: str) -> mp.ManeuverCandidate:
    cand = sess.maneuvers.get(maneuver_id)
    if cand is None:
        raise NotFound(f"maneuver '{maneuver_id}' not found; plan maneuvers first")
    return cand


def run_secondary_check(sess: SimulationSession, maneuver_id: str,
                        window_end_unix: Optional[float] = None) -> Dict[str, Any]:
    cand = get_maneuver(sess, maneuver_id)
    scen = sess.scenario
    primary = scen.catalog.require(scen.primary_id)
    policy = sess.screening_pc_policy or scen.pc_policy
    prof = profile_for(sess)
    if window_end_unix is None:
        window_end_unix = sess.screening_window[1] if sess.screening_window else scen.end_unix
    window_end_unix = max(float(window_end_unix), float(cand.post_tca_unix) + 900.0)
    with sess.lock:
        objects, _ = _screening_objects(sess, primary.object_id)
        # Objects co-orbital with the primary in the baseline screening share its elements (vehicles docked to
        # the ISS): they move with it when it burns, so the post-burn path is not screened against them.
        docked = {x["object_id"]: x["name"].strip() for x in (sess.screening or {}).get("co_orbital", [])}
        objects = [o for o in objects if o.object_id not in docked]
        try:
            result = ss.check_secondary(cand, primary, objects, window_end_unix,
                                        list(sess.conjunctions.values()), get_settings(), policy,
                                        require_distance_target=prof.require_distance_target)
        except ValueError as exc:
            raise Conflict(f"maneuver {maneuver_id} cannot be checked against the current trajectory: {exc}") from exc
        if docked:
            result["limitations"].append("not screened, docked/co-located with the primary (they move with it): "
                                         + ", ".join(sorted(docked.values())))
        result["scenario_id"] = sess.scenario_id
        result["catalog_version"] = sess.catalog_version
        result["primary_version"] = sess.primary_version
        sess.secondary_checks[maneuver_id] = result
        cand.secondary_check = {
            "validation_status": result["validation_status"], "complete": result["complete"],
            "new_conjunctions": len(result["new_conjunctions"]), "worst_new_state": result["worst_new_state"],
            "original_encounter": result["original_encounter"], "limitations": result["limitations"],
        }
    return result


# --------------------------------------------------------------------------
# committing burns (human approval and the sandbox autopilot)
# --------------------------------------------------------------------------

def commit(sess: SimulationSession, maneuver_id: str, now_unix: Optional[float] = None,
           source: str = "human") -> Dict[str, Any]:
    """Make a candidate burn part of the primary's trajectory.

    Guards: the candidate must be feasible, planned against the current trajectory (nothing committed
    since), pass a secondary check against the current catalog, and come after the last committed burn.
    Afterwards the session's window is screened again, so the conjunction list and the derived
    overall state reflect the committed path."""
    cand = get_maneuver(sess, maneuver_id)
    scen = sess.scenario
    settings = get_settings()
    prof = profile_for(sess)
    with sess.lock:
        if sess.is_committed(maneuver_id):
            raise Conflict(f"maneuver {maneuver_id} is already committed")
        if not cand.feasible:
            raise Conflict(f"maneuver {maneuver_id} is not feasible: {'; '.join(cand.feasibility_reasons)}")
        if cand.primary_version is not None and cand.primary_version != sess.primary_version:
            raise Conflict(f"maneuver {maneuver_id} was planned against an earlier trajectory (a burn was committed "
                           f"or withdrawn since); plan again")
        check = sess.secondary_checks.get(maneuver_id)
        if (check is None or check.get("catalog_version") != sess.catalog_version
                or check.get("primary_version") != sess.primary_version):
            check = run_secondary_check(sess, maneuver_id)
        if check["validation_status"] == "FAIL":
            raise Conflict(f"maneuver {maneuver_id} failed secondary screening "
                           f"(worst new state {check['worst_new_state']}, original encounter meets target: "
                           f"{check['original_encounter']['meets_target']})")
        primary = scen.catalog.require(scen.primary_id)
        try:
            committed_primary = mp.with_burn(primary, cand)
        except ValueError as exc:
            raise Conflict(str(exc)) from exc
        conj = sess.conjunctions.get(cand.conjunction_id)
        secondary_id = conj.secondary_id if conj else None
        scen.catalog.replace(committed_primary)
        sess.primary_version += 1
        decision = sess.record_decision("APPROVED" if source == "human" else "AUTOPILOT_COMMITTED", maneuver_id,
                                        source=source)
        ok, basis = meets_mitigation_target(cand.post_miss_distance_km, cand.post_pc, settings,
                                            require_distance=prof.require_distance_target)
        at = now_unix if now_unix is not None else sess.clock_unix
        sess.committed.append(CommittedBurn(cand, source, decision["at"], at, check["validation_status"], bool(ok), basis))
        who = "Autopilot" if source == "autopilot" else "Operator"
        sess.add_event("COMMITTED",
                       f"{who} committed {maneuver_id}: {cand.direction} {cand.dv_magnitude_mps:g} m/s at "
                       f"{iso(cand.burn_time_unix)}, post-burn miss {cand.post_miss_distance_km:.2f} km",
                       at_unix=at, maneuver_id=maneuver_id, conjunction_id=cand.conjunction_id,
                       secondary_id=secondary_id, burn_time_unix=float(cand.burn_time_unix),
                       post_miss_km=float(cand.post_miss_distance_km), source=source)
        sess.invalidate_perception()
        _rescreen(sess)
        new_states = [c["threat_state"] for c in check["new_conjunctions"]]
        residual = [x["after_state"] for x in check["changed_conjunctions"] if x.get("after_state")]
        others = worst_state([st for st in new_states + residual if st in ORDER] or ["NORMAL"])
        sess.post_approval = {
            "maneuver_id": maneuver_id, "conjunction_id": cand.conjunction_id, "source": source,
            "post_miss_distance_km": float(cand.post_miss_distance_km), "post_tca": iso(cand.post_tca_unix),
            "post_pc": cand.post_pc.to_dict() if cand.post_pc else None, "post_threat_state": cand.post_threat_state,
            "meets_target": bool(ok), "target_basis": basis, "secondary_check_status": check["validation_status"],
            "new_conjunctions": len(check["new_conjunctions"]), "worst_other_state": others,
            "overall_threat_state": sess.overall_threat_state(), "approved_at": decision["at"],
        }
    return {"decision": decision, "maneuver": cand.to_dict(), "secondary_check": check,
            "simulation": sess.state_summary()}


def uncommit(sess: SimulationSession, maneuver_id: str) -> CommittedBurn:
    """Withdraw the latest committed burn (earlier ones carry later arcs and cannot be removed alone)."""
    with sess.lock:
        if not sess.committed or sess.committed[-1].maneuver_id != maneuver_id:
            latest = sess.committed[-1].maneuver_id if sess.committed else "none"
            raise Conflict(f"only the latest committed burn can be withdrawn (latest: {latest})")
        scen = sess.scenario
        scen.catalog.replace(mp.without_last_burn(scen.catalog.require(scen.primary_id)))
        burn = sess.committed.pop()
        sess.primary_version += 1
        sess.post_approval = None
        sess.add_event("UNCOMMITTED", f"Burn {maneuver_id} withdrawn; the trajectory returns to the previous path",
                       maneuver_id=maneuver_id)
        sess.invalidate_perception()
        _rescreen(sess)
    return burn


def approve(sess: SimulationSession, maneuver_id: str) -> Dict[str, Any]:
    return commit(sess, maneuver_id, source="human")


def reject(sess: SimulationSession, maneuver_id: str, reason: Optional[str] = None) -> Dict[str, Any]:
    cand = get_maneuver(sess, maneuver_id)
    withdrawn = sess.is_committed(maneuver_id)
    if withdrawn:
        uncommit(sess, maneuver_id)
    decision = sess.record_decision("REJECTED", maneuver_id, reason,
                                    note=DECISION_WITHDRAWN if withdrawn else None)
    return {"decision": decision, "maneuver": cand.to_dict(), "secondary_check": sess.secondary_checks.get(maneuver_id),
            "simulation": sess.state_summary()}


DECISION_WITHDRAWN = "Committed burn withdrawn in simulation; the trajectory returns to the previous path."


def set_autopilot(sess: SimulationSession, enabled: bool) -> Dict[str, Any]:
    if not sess.sandbox:
        raise Conflict("the autopilot exists only in the sandbox (synthetic) scenario")
    with sess.lock:
        sess.autopilot = bool(enabled)
        sess.add_event("AUTOPILOT", f"Autopilot {'engaged' if enabled else 'disengaged'}")
    return sess.state_summary()


# --------------------------------------------------------------------------
# perception
# --------------------------------------------------------------------------

def perception(sess: SimulationSession, horizon_s: Optional[float] = None, critical_radius_km: Optional[float] = None,
               tracked_radius_km: Optional[float] = None, maneuver_id: Optional[str] = None,
               include_hidden: bool = False, trails: bool = True, baseline: bool = False,
               start: Optional[str] = None) -> Dict[str, Any]:
    if maneuver_id and maneuver_id not in sess.maneuvers:
        raise NotFound(f"maneuver '{maneuver_id}' not found in this session")
    start_unix = _parse_time(start, _default_start(sess))
    try:
        return perceive(sess, horizon_s=horizon_s, critical_radius_km=critical_radius_km,
                        tracked_radius_km=tracked_radius_km, maneuver_id=maneuver_id, include_hidden=include_hidden,
                        trails=trails, settings=get_settings(), baseline=baseline, start_unix=start_unix)
    except ValueError as exc:
        raise BadRequest(str(exc)) from exc


def perception_model_info() -> Dict[str, Any]:
    return load_risk_model(get_settings().perception_model_meta_file).info.to_dict()
