"""Runtime perception: which objects deserve attention around the primary.

The model scores every catalog object from its elements in milliseconds; the
physics screening then verifies the flagged objects (and, for catalogs of
demo size, everything in the altitude band) and provides every displayed
distance and time. Tiers:

    CRITICAL       verified miss < critical radius, or threat state CRITICAL
    SEMI_CRITICAL  verified miss < tracked radius (the local "traffic")
    ML_WATCH       model score above its operating threshold but physics-cleared
                   or unverifiable (never upgraded to a physics tier)
    HIDDEN         everything else (counts only unless include_hidden)
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from ..config import Settings, get_settings
from ..data.catalog import OrbitalObject
from ..physics import collision_probability as cp
from ..physics import maneuver_planner as mp
from ..physics.frames import relative_positions_rtn, relative_state_rtn
from ..physics.propagation import propagate
from ..physics.screening import Conjunction, altitude_overlap_filter, anchor, screen
from ..physics.threat import evaluate_threat_state, thresholds_summary
from ..physics.time_utils import iso
from .features import pair_features
from .model import RiskModel, load_risk_model

TIER_ORDER = ["CRITICAL", "SEMI_CRITICAL", "ML_WATCH", "HIDDEN"]
MATCH_WINDOW_S = 600.0
MODE_FULL, MODE_ML = "FULL_PHYSICS", "ML_PRIORITISED"
DISCLAIMER = ("Model scores are estimates from a classifier trained on CelesTrak-derived screening labels; every "
              "distance and time shown is computed by the physics screening. Simulation only.")


def tier_rules(critical_km: float, tracked_km: float, watch_thr: Optional[float]) -> List[str]:
    return [
        "CRITICAL: backend threat state CRITICAL or ELEVATED (collision probability above the configured thresholds); "
        f"when no probability can be computed, a physics-verified miss distance below {critical_km:g} km",
        f"SEMI_CRITICAL: any other physics-verified approach inside {tracked_km:g} km (the local traffic)",
        (f"ML_WATCH: model score >= {watch_thr:.3f} but no verified approach inside {tracked_km:g} km "
         f"(cleared by physics or not verifiable)") if watch_thr is not None else "ML_WATCH: unavailable (no model loaded)",
        "HIDDEN: everything else. The model can only add ML_WATCH entries; physics decides the other tiers.",
    ]


def critical_tier(c: Conjunction, critical_km: float) -> bool:
    """Threat state decides when a probability exists; distance only when it does not."""
    if c.pc is not None and c.pc.status == "COMPUTED" and c.pc.value is not None:
        return c.threat_state in ("CRITICAL", "ELEVATED")
    return c.miss_distance_km < critical_km


def resolve_primary_variant(sess, maneuver_id: Optional[str], start_unix: float, end_unix: float):
    """(kind, candidate, segments[(primary_object, t_start, t_end)]) for the trajectory to perceive along."""
    scen = sess.scenario
    primary = scen.catalog.require(scen.primary_id)
    cand = None
    kind = "ORIGINAL"
    if maneuver_id:
        cand = sess.maneuvers.get(maneuver_id)
        if cand is None:
            raise KeyError(f"maneuver '{maneuver_id}' not found in this session")
        kind = "APPROVED" if sess.approved_maneuver_id == maneuver_id else "CANDIDATE"
    elif sess.approved_maneuver_id and sess.approved_maneuver_id in sess.maneuvers:
        cand = sess.maneuvers[sess.approved_maneuver_id]
        kind = "APPROVED"
    if cand is None:
        return kind, None, [(primary, start_unix, end_unix)]
    tb = float(cand.burn_time_unix)
    segments = []
    if tb > start_unix:
        segments.append((primary, start_unix, min(tb, end_unix)))
    if tb < end_unix:
        segments.append((mp.maneuvered_primary(primary, cand), max(tb, start_unix), end_unix))
    return kind, cand, segments


def horizon_for(scen, primary: OrbitalObject, requested_s: Optional[float], settings: Settings) -> Dict[str, Any]:
    period = primary.period_s or 5600.0
    window = scen.end_unix - scen.start_unix
    horizon = max(float(requested_s) if requested_s else window, settings.perception_min_horizon_orbits * period)
    start = scen.start_unix
    end = start + horizon
    return {"start": iso(start), "end": iso(end), "start_unix": start, "end_unix": end, "horizon_s": horizon,
            "min_horizon_orbits": settings.perception_min_horizon_orbits, "primary_period_s": period,
            "extends_past_window": end > scen.end_unix + 1e-6}


def _score(model: RiskModel, primary: OrbitalObject, objects: Sequence[OrbitalObject], t_ref: float):
    """Scores (NaN where elements are missing or no model), per-object elements basis, note, duration."""
    t = time.time()
    note = None
    try:
        fm = pair_features(primary, objects, t_ref)
    except ValueError as exc:
        return np.full(len(objects), np.nan), [None] * len(objects), f"features unavailable: {exc}", time.time() - t
    scores = model.predict_proba(fm.X)
    if scores is None:
        return np.full(len(objects), np.nan), fm.basis, "no model loaded; physics-only tiers", time.time() - t
    scores = np.asarray(scores, dtype=float)
    scores[~fm.ok_mask] = np.nan
    if fm.primary_basis != "SGP4_MEAN":
        note = "primary scored from osculating elements at its state epoch (synthetic/post-burn state)"
    return scores, fm.basis, note, time.time() - t


def _select_physics_set(primary: OrbitalObject, objects: List[OrbitalObject], scores: np.ndarray,
                        settings: Settings) -> Tuple[List[OrbitalObject], str, List[str]]:
    if len(objects) <= settings.perception_full_screen_max_objects or np.isnan(scores).all():
        return objects, MODE_FULL, []
    k = settings.perception_screen_top_k
    order = np.argsort(-np.nan_to_num(scores, nan=-1.0))
    chosen = {objects[i].object_id for i in order[:k]}
    band = altitude_overlap_filter(primary, objects, settings.perception_guaranteed_band_margin_km)
    chosen.update(o.object_id for o in band)
    subset = [o for o in objects if o.object_id in chosen]
    return subset, MODE_ML, [f"catalog has {len(objects)} objects: physics screening limited to the model's top {k} "
                             f"plus the {len(band)} objects within {settings.perception_guaranteed_band_margin_km:g} km of "
                             f"the primary's altitude band ({len(subset)} screened)"]


def _screen_segments(segments, objects, tracked_km: float, settings: Settings, pc_policy: str, catalog, full: bool):
    found: List[Tuple[Conjunction, OrbitalObject, str]] = []
    stats = []
    co_orbital: List[Dict[str, Any]] = []
    failures: List[Dict[str, Any]] = []
    coarse: Dict[str, Tuple[float, float]] = {}
    complete = True
    pad = 2.0 * settings.screening_coarse_step_s  # overlap so a minimum at the burn boundary is interior to one segment
    nominal = list(segments)
    for seg_index, (pobj, t0, t1) in enumerate(segments):
        if t1 - t0 < settings.screening_coarse_step_s:
            continue
        s0, s1 = t0, t1
        if len(segments) > 1 and seg_index == 0:
            s1 = t1 + pad
        if len(segments) > 1 and seg_index == len(segments) - 1:
            s0 = t0 - pad
        res = screen(pobj, objects, s0, s1, screening_radius_km=tracked_km, coarse_step_s=settings.screening_coarse_step_s,
                     altitude_margin_km=settings.altitude_filter_margin_km,
                     co_orbital_min_speed_kms=settings.co_orbital_min_relative_speed_kms,
                     numerical_step_s=settings.planner_numerical_step_s, apply_altitude_filter=full)
        label = "pre-burn" if len(segments) > 1 and seg_index == 0 else ("post-burn" if len(segments) > 1 else "original")
        for c in res.conjunctions:
            sec = catalog.require(c.secondary_id)
            c.pc = cp.compute_pc_for_conjunction(c, pobj, sec, pc_policy)
            c.threat_state, c.threat_rationale = evaluate_threat_state(c.miss_distance_km, c.pc, settings)
            found.append((c, pobj, label))
        for oid, (d, t) in res.coarse_minima.items():
            if oid not in coarse or d < coarse[oid][0]:
                coarse[oid] = (d, t)
        stats.append({"segment": label, **res.stats})
        co_orbital.extend(res.co_orbital)
        failures.extend(res.propagation_failures)
        complete = complete and res.stats["complete"]
    if len(nominal) > 1:
        # keep each encounter once: the detection whose TCA lies inside its own segment's nominal range wins
        kept: List[Tuple[Conjunction, OrbitalObject, str]] = []
        for c, pobj, label in found:
            seg = next((n for n in nominal if n[0] is pobj), None)
            inside = seg is not None and seg[1] - 1e-6 <= c.tca_unix <= seg[2] + 1e-6
            dup = next((i for i, (k, _, _) in enumerate(kept) if k.secondary_id == c.secondary_id
                        and abs(k.tca_unix - c.tca_unix) <= pad), None)
            if dup is None:
                kept.append((c, pobj, label))
            elif inside:
                kept[dup] = (c, pobj, label)
        found = kept
    return found, stats, co_orbital, failures, coarse, complete


def _link(c: Conjunction, sess) -> Tuple[Optional[str], Optional[str]]:
    if c.conjunction_id in sess.conjunctions:
        return c.conjunction_id, "exact"
    for known in sess.conjunctions.values():
        if known.secondary_id == c.secondary_id and abs(known.tca_unix - c.tca_unix) <= MATCH_WINDOW_S:
            return known.conjunction_id, f"same object within {MATCH_WINDOW_S:.0f} s"
    return None, None


def _compact_pc(pc) -> Optional[Dict[str, Any]]:
    if pc is None:
        return None
    return {"status": pc.status, "value": pc.value, "covariance_basis": pc.covariance_basis, "reason": pc.reason,
            "hard_body_radius_m": pc.hard_body_radius_m}


def _trail(pobj: OrbitalObject, sec: OrbitalObject, center: float, half_width_s: float, step_s: float,
           numerical_step_s: float) -> Optional[Dict[str, Any]]:
    times = center + np.arange(-half_width_s, half_width_s + 1e-6, step_s)
    p = anchor(pobj, float(times[0]), numerical_step_s)
    s = anchor(sec, float(times[0]), numerical_step_s)
    rp = propagate(p, times, numerical_step_s)
    rs = propagate(s, times, numerical_step_s)
    if rp.status != "OK" or rs.status != "OK":
        return None
    rtn = relative_positions_rtn(rp.positions_km, rp.velocities_kms, rs.positions_km)
    return {"frame": "RTN of the primary (origin at the primary, R radial, T along-track, N cross-track; axes rotate with it)",
            "center_unix": float(center), "step_s": float(step_s), "times_unix": [float(t) for t in times],
            "positions_rtn_km": [[float(x) for x in row] for row in rtn],
            "basis": "secondary minus primary positions, both propagated with their native models"}


def perceive(sess, horizon_s: Optional[float] = None, critical_radius_km: Optional[float] = None,
             tracked_radius_km: Optional[float] = None, maneuver_id: Optional[str] = None, include_hidden: bool = False,
             trails: bool = True, settings: Optional[Settings] = None, model: Optional[RiskModel] = None) -> Dict[str, Any]:
    settings = settings or get_settings()
    scen = sess.scenario
    catalog = scen.catalog
    primary = catalog.require(scen.primary_id)
    critical = float(critical_radius_km or settings.perception_critical_radius_km)
    tracked = float(tracked_radius_km or settings.screening_radius_km)
    if critical > tracked:
        raise ValueError(f"critical radius {critical:g} km must not exceed the tracked radius {tracked:g} km")
    hz = horizon_for(scen, primary, horizon_s, settings)
    kind, cand, segments = resolve_primary_variant(sess, maneuver_id, hz["start_unix"], hz["end_unix"])
    model = model or load_risk_model(settings.perception_model_meta_file)
    watch_thr = settings.perception_ml_watch_threshold
    if watch_thr is None and model.info.status == "LOADED":
        watch_thr = model.info.threshold if model.info.threshold is not None else 0.5
    pc_policy = sess.screening_pc_policy or scen.pc_policy
    key = (kind, cand.maneuver_id if cand else None, round(hz["horizon_s"], 3), critical, tracked, watch_thr,
           include_hidden, trails, model.info.model_version, model.info.library, pc_policy)
    cached = sess.perception_cache.get(key)
    if cached is not None:
        return {**cached, "cached": True}

    t_wall = time.time()
    objects = [o for o in catalog.others(primary.object_id) if o.validation_status != "INVALID"]
    scores, elements_basis, ml_note, score_s = _score(model, primary, objects, hz["start_unix"])
    physics_set, mode, limitations = _select_physics_set(primary, objects, scores, settings)
    t_scr = time.time()
    found, seg_stats, co_orbital, failures, coarse, complete = _screen_segments(
        segments, physics_set, tracked, settings, pc_policy, catalog, full=(mode == MODE_FULL))
    screen_s = time.time() - t_scr
    if hz["extends_past_window"]:
        limitations.append("horizon extends past the scenario window; the UI holds trajectories only up to the window end")
    if not complete:
        limitations.append("some objects could not be propagated; their status is PROPAGATION_FAILED")
    screened_ids = {o.object_id for o in physics_set}
    band_ids = ({o.object_id for o in altitude_overlap_filter(primary, physics_set, settings.altitude_filter_margin_km)}
                if mode == MODE_FULL else screened_ids)
    failed_ids = {f["object_id"] for f in failures}
    co_orbital_ids = {x["object_id"] for x in co_orbital}
    score_by_id = {o.object_id: (None if np.isnan(scores[i]) else float(scores[i])) for i, o in enumerate(objects)}
    basis_by_id = {o.object_id: elements_basis[i] for i, o in enumerate(objects)}

    def ml_block(oid: str) -> Dict[str, Any]:
        sc = score_by_id.get(oid)
        predicted = None
        if sc is not None and watch_thr is not None:
            predicted = "WATCH" if sc >= watch_thr else "CLEAR"
        return {"score": sc, "predicted_tier": predicted, "model_version": model.info.model_version,
                "basis": "MODEL_ESTIMATE" if sc is not None else "UNAVAILABLE", "note": ml_note,
                "elements_basis": basis_by_id.get(oid)}

    entries: List[Dict[str, Any]] = []
    with_conj = set()
    for c, pobj, seg_label in sorted(found, key=lambda t: t[0].miss_distance_km):
        sec = catalog.require(c.secondary_id)
        with_conj.add(c.secondary_id)
        tier = "CRITICAL" if critical_tier(c, critical) else "SEMI_CRITICAL"
        rel_r, rel_v = relative_state_rtn(c.primary_r_km, c.primary_v_kms, c.secondary_r_km, c.secondary_v_kms)
        linked, link_basis = _link(c, sess)
        physics = {
            "status": "CONJUNCTION", "verified": True, "conjunction_id": c.conjunction_id,
            "linked_conjunction_id": linked, "link_basis": link_basis,
            "tca": iso(c.tca_unix), "tca_unix": float(c.tca_unix), "time_to_tca_s": float(c.tca_unix - scen.start_unix),
            "miss_distance_km": float(c.miss_distance_km), "relative_speed_kms": float(c.relative_speed_kms),
            "miss_vector_rtn_km": [float(x) for x in rel_r], "relative_velocity_rtn_kms": [float(x) for x in rel_v],
            "relative_position_teme_km": [float(x) for x in c.relative_position_teme_km],
            "threat_state": c.threat_state, "threat_rationale": list(c.threat_rationale), "pc": _compact_pc(c.pc),
            "coarse_min_distance_km": float(c.coarse_min_distance_km), "coarse_min_at": None,
            "models": {"primary": c.primary_model, "secondary": c.secondary_model}, "segment": seg_label,
        }
        trail = None
        if trails and tier == "CRITICAL" or (trails and tier == "SEMI_CRITICAL"):
            trail = _trail(pobj, sec, c.tca_unix, settings.perception_trail_half_width_s, settings.perception_trail_step_s,
                           settings.planner_numerical_step_s)
        entries.append({"object_id": sec.object_id, "name": sec.name, "category": sec.category, "tier": tier,
                        "ml": ml_block(sec.object_id), "physics": physics, "trail": trail})

    watch: List[Dict[str, Any]] = []
    hidden: List[Dict[str, Any]] = []
    n_hidden = 0
    for o in objects:
        if o.object_id in with_conj:
            continue
        sc = score_by_id.get(o.object_id)
        clearance = None
        if o.object_id in failed_ids:
            status, verified = "PROPAGATION_FAILED", False
        elif o.object_id in co_orbital_ids:
            status, verified = "CO_ORBITAL", True
        elif o.object_id in screened_ids and o.object_id in band_ids:
            status, verified = "CLEARED", True
            clearance = "propagated over the horizon; closest coarse sample outside the tracked radius"
        elif o.object_id in screened_ids:
            status, verified = "CLEARED", True
            clearance = (f"altitude band filter: perigee/apogee band does not overlap the primary's band within "
                         f"{settings.altitude_filter_margin_km:g} km")
        else:
            status, verified = "NOT_SCREENED", False
        cm = coarse.get(o.object_id)
        physics = {"status": status, "verified": verified, "conjunction_id": None, "linked_conjunction_id": None,
                   "link_basis": None, "clearance": clearance if status == "CLEARED" else None, "tca": None, "tca_unix": None, "time_to_tca_s": None, "miss_distance_km": None,
                   "relative_speed_kms": None, "miss_vector_rtn_km": None, "relative_velocity_rtn_kms": None,
                   "relative_position_teme_km": None, "threat_state": "NORMAL" if verified else None,
                   "threat_rationale": [], "pc": None,
                   "coarse_min_distance_km": float(cm[0]) if cm else None, "coarse_min_at": iso(cm[1]) if cm else None,
                   "models": {"primary": primary.propagation_model, "secondary": o.propagation_model}, "segment": None}
        entry = {"object_id": o.object_id, "name": o.name, "category": o.category, "tier": "ML_WATCH",
                 "ml": ml_block(o.object_id), "physics": physics, "trail": None}
        if sc is not None and watch_thr is not None and sc >= watch_thr:
            watch.append(entry)
        else:
            n_hidden += 1
            if include_hidden:
                hidden.append({**entry, "tier": "HIDDEN"})
    watch.sort(key=lambda e: -(e["ml"]["score"] or 0.0))
    if len(watch) > settings.perception_max_watch_objects:
        limitations.append(f"{len(watch) - settings.perception_max_watch_objects} ML_WATCH objects beyond the top "
                           f"{settings.perception_max_watch_objects} by score are not listed")
        watch = watch[: settings.perception_max_watch_objects]
    entries = entries + watch + hidden
    entries.sort(key=lambda e: (TIER_ORDER.index(e["tier"]),
                                e["physics"]["miss_distance_km"] if e["physics"]["miss_distance_km"] is not None else 1e9,
                                -(e["ml"]["score"] or 0.0)))
    for i, e in enumerate(entries):
        e["rank"] = i + 1
    counts = {t: sum(1 for e in entries if e["tier"] == t) for t in TIER_ORDER}
    counts["HIDDEN"] = n_hidden
    counts.update({"total": len(objects), "physics_screened": len(physics_set),
                   "ml_scored": int(np.count_nonzero(~np.isnan(scores))), "co_orbital": len(co_orbital),
                   "failed": len(failures), "encounters": len(found)})
    thresholds = {"critical_radius_km": critical, "tracked_radius_km": tracked, "horizon_s": hz["horizon_s"],
                  "near_field_horizon_s": settings.perception_near_field_horizon_s, "ml_watch_threshold": watch_thr,
                  "coarse_step_s": settings.screening_coarse_step_s,
                  "co_orbital_min_relative_speed_kms": settings.co_orbital_min_relative_speed_kms,
                  **thresholds_summary(settings)}
    result = {
        "scenario_id": sess.scenario_id, "primary_id": primary.object_id,
        "primary_variant": {"kind": kind, "maneuver_id": cand.maneuver_id if cand else None,
                            "burn_time": iso(cand.burn_time_unix) if cand else None,
                            "segments": [{"start": iso(t0), "end": iso(t1), "model": p.propagation_model, "basis": p.position_basis}
                                         for p, t0, t1 in segments]},
        "horizon": hz, "thresholds": thresholds, "tier_rules": tier_rules(critical, tracked, watch_thr),
        "screening_mode": mode, "objects": entries, "counts": counts, "model": model.info.to_dict(),
        "stats": {"duration_s": round(time.time() - t_wall, 3), "score_duration_s": round(score_s, 4),
                  "screen_duration_s": round(screen_s, 3), "segments": seg_stats},
        "co_orbital": co_orbital, "propagation_failures": failures, "complete": complete,
        "limitations": limitations, "disclaimer": DISCLAIMER, "cached": False,
    }
    sess.perception_cache[key] = result
    return result
