"""The live sandbox on the synthetic scenario: spawn space junk around the primary and let the
autopilot find and commit avoidance burns.

Spawning mirrors the synthetic scenario's construction: a junk object is *defined at its closest
approach* (the primary's state at that time plus a designed miss vector, velocity rotated by a
crossing angle) and back-propagated to the spawn time, so the pass happens exactly as designed up
to integrator error. The junk type decides the miss-distance band (fragment: close, critical;
rocket body: middle; dead satellite: outer, slow, near-co-orbital), the crossing angle, the size
and the illustrative covariance.

``evaluate`` is the autopilot's loop: screen from ``now`` over the profile's horizon, then for every
pass that needs mitigation plan a burn with the sandbox profile (short leads, larger burns, both
the probability and the distance target required), secondary-check it, and commit it. Burns are
append-only in time, so a pass that no burn can clear any more is reported as unavoidable.
Everything is simulation; nothing commands a spacecraft.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from ..config import get_settings
from ..data.catalog import OrbitalObject
from ..data.spacecraft import BOX_WING_BUS, DEBRIS_FRAGMENT, ROCKET_BODY, SpacecraftDesign
from ..physics.constants import MU_EARTH_KM3_S2
from ..physics.frames import ecef_to_geodetic, osculating_elements, rotate_about, rtn_basis, teme_to_ecef
from ..physics.propagation import (MODEL_NUMERICAL, MODEL_PIECEWISE, anchored, propagate, propagate_states, state_at)
from ..physics.screening import Conjunction
from ..physics.threat import ORDER
from ..physics.time_utils import from_unix, iso
from . import service
from .session import SimulationSession

MIN_TIME_TO_TCA_S = 180.0
MAX_RANDOM_COUNT = 20
# Random junk gets at least half an hour of warning: with less, only large burns clear the distance target.
RANDOM_MIN_LEAD_S = 1800.0


@dataclass(frozen=True)
class JunkType:
    kind: str
    category: str
    label: str
    name_prefix: str
    blurb: str
    miss_band_km: Tuple[float, float]
    radial_fraction: Tuple[float, float]  # share of the miss vector along the radial axis
    crossing_deg: Tuple[float, float]
    speed_factor: Tuple[float, float]  # x circular speed at the pass: not exactly 1 so repeat passes drift
    radius_m: float
    sigmas_rtn_m: Tuple[float, float, float]
    design: SpacecraftDesign

    def to_dict(self) -> Dict[str, Any]:
        return {"kind": self.kind, "category": self.category, "label": self.label, "blurb": self.blurb,
                "band_km": list(self.miss_band_km), "crossing_deg": list(self.crossing_deg), "radius_m": self.radius_m,
                "relative_speed_kms": [round(2.0 * 7.66 * np.sin(np.radians(a) / 2.0), 3) for a in self.crossing_deg],
                "design": self.design.as_dict()}


JUNK_TYPES: Dict[str, JunkType] = {
    "fragment": JunkType(
        "fragment", "DEBRIS", "Fragment", "FRAG",
        "A small fast fragment on a crossing orbit: passes inside the critical radius, the autopilot must dodge it.",
        (0.1, 3.0), (0.0, 0.3), (20.0, 80.0), (1.000, 1.004), 1.0, (150.0, 400.0, 150.0),
        SpacecraftDesign(DEBRIS_FRAGMENT, "Sandbox fragment", 0.9, 0.5, 0.3, "SCENARIO_DEFINITION", "sandbox junk type table")),
    "rocket_body": JunkType(
        "rocket_body", "ROCKET_BODY", "Rocket body", "RB",
        "A spent upper stage passing a few km away: tracked traffic, sometimes close enough to need a burn.",
        (3.0, 10.0), (0.0, 0.3), (10.0, 60.0), (0.996, 1.004), 4.0, (300.0, 1000.0, 300.0),
        SpacecraftDesign(ROCKET_BODY, "Sandbox spent upper stage", 8.0, 2.6, 2.6, "SCENARIO_DEFINITION", "sandbox junk type table")),
    "dead_satellite": JunkType(
        "dead_satellite", "PAYLOAD", "Dead satellite", "DEADSAT",
        "A defunct satellite on a nearly co-orbital path: drifts past slowly in the outer band.",
        (10.0, 22.0), (0.0, 0.1), (0.5, 3.0), (1.0, 1.0), 3.0, (200.0, 800.0, 200.0),
        SpacecraftDesign(BOX_WING_BUS, "Sandbox defunct satellite", 1.5, 6.0, 1.2, "SCENARIO_DEFINITION", "sandbox junk type table")),
}
RANDOM_KIND_WEIGHTS = {"fragment": 0.5, "rocket_body": 0.3, "dead_satellite": 0.2}


@dataclass
class SpawnSpec:
    kind: str
    time_to_tca_s: Optional[float] = None
    drop_point: Optional[Tuple[float, float]] = None  # (lat_deg, lon_deg): the pass happens over this spot
    offset_km: Optional[float] = None  # explicit miss distance instead of a draw from the band
    axis: str = "horizontal"  # horizontal | radial: where an explicit offset points
    crossing_angle_deg: Optional[float] = None
    seed: Optional[int] = None
    name: Optional[str] = None


def _require_sandbox(sess: SimulationSession) -> None:
    if not sess.sandbox:
        raise service.Conflict("spawning and the autopilot exist only in the sandbox (synthetic) scenario")


# --------------------------------------------------------------------------
# encounter construction
# --------------------------------------------------------------------------

def construct_encounter(primary: OrbitalObject, t_now: float, t_tca: float, miss_h_km: float, miss_r_km: float,
                        crossing_deg: float, speed_factor: float = 1.0, step_s: float = 10.0):
    """State (r, v at t_now) of an object that passes the primary at t_tca with the designed miss vector.

    The object is defined at the closest approach (the primary's state there, plus the miss vector in
    the local horizontal/radial directions, velocity rotated by the crossing angle about the radial
    axis) and back-propagated to t_now with the same two-body + J2 model used for screening."""
    if abs(crossing_deg) < 0.3:
        raise ValueError("crossing angle must be at least 0.3 degrees (smaller is co-orbital, not a pass)")
    if t_tca - t_now < MIN_TIME_TO_TCA_S:
        raise ValueError(f"the closest approach must be at least {MIN_TIME_TO_TCA_S:.0f} s after the spawn time")
    r_pt, v_pt = state_at(primary, float(t_tca), step_s)
    basis = rtn_basis(r_pt, v_pt)
    radial = basis[:, 0]
    v_dir = rotate_about(v_pt / np.linalg.norm(v_pt), radial, np.radians(crossing_deg))
    v_rel_dir = v_dir * np.linalg.norm(v_pt) - v_pt
    v_rel_dir /= np.linalg.norm(v_rel_dir)
    horizontal = np.cross(radial, v_rel_dir)
    horizontal /= np.linalg.norm(horizontal)
    r_st = r_pt + miss_h_km * horizontal + miss_r_km * radial
    v_st = v_dir * speed_factor * np.sqrt(MU_EARTH_KM3_S2 / np.linalg.norm(r_st))
    y_now = propagate_states(np.concatenate([r_st, v_st])[None, :], float(t_tca), np.array([float(t_now)]), step_s)[0, 0]
    designed = {
        "tca": iso(t_tca), "tca_unix": float(t_tca), "time_to_tca_s": float(t_tca - t_now),
        "miss_km": float(np.hypot(miss_h_km, miss_r_km)), "miss_horizontal_km": float(miss_h_km),
        "miss_radial_km": float(miss_r_km), "crossing_angle_deg": float(crossing_deg),
        "relative_speed_kms": float(np.linalg.norm(v_st - v_pt)), "speed_factor": float(speed_factor),
    }
    return y_now[:3], y_now[3:], designed


def make_junk_object(sess: SimulationSession, kind: str, r_now: np.ndarray, v_now: np.ndarray, now_unix: float,
                     designed: Dict[str, Any], name: Optional[str] = None, seed: Optional[int] = None) -> OrbitalObject:
    jt = JUNK_TYPES[kind]
    catalog = sess.scenario.catalog
    seq = sum(1 for oid in sess.spawned_ids if oid.startswith(f"SBX-{jt.name_prefix}-")) + 1
    object_id = f"SBX-{jt.name_prefix}-{seq:03d}"
    while object_id in catalog:
        seq += 1
        object_id = f"SBX-{jt.name_prefix}-{seq:03d}"
    el = osculating_elements(r_now, v_now)
    obj = OrbitalObject(
        object_id=object_id, name=name or f"{jt.label} {seq} (sandbox junk)", category=jt.category,
        category_basis="SANDBOX_SPAWN", source="sandbox",
        source_detail=f"spawned {iso(now_unix)} kind={kind} seed={seed}", epoch=from_unix(now_unix),
        propagation_model=MODEL_NUMERICAL, position_basis="SANDBOX_SPAWN", state_epoch_unix=float(now_unix),
        r0_teme_km=np.asarray(r_now, float).copy(), v0_teme_kms=np.asarray(v_now, float).copy(),
        radius_m=jt.radius_m, radius_basis="SCENARIO_DEFINITION",
        covariance_rtn_m2=np.diag([s * s for s in jt.sigmas_rtn_m]), covariance_source="ASSUMED_ILLUSTRATIVE",
        perigee_alt_km=el["perigee_alt_km"], apogee_alt_km=el["apogee_alt_km"], period_s=el["period_s"],
        inclination_deg=el["inclination_deg"], design_override=jt.design, spawned_at_unix=float(now_unix),
        spawn={"kind": kind, **designed, "seed": seed, "band_km": list(jt.miss_band_km)},
    )
    # join the common integration epoch so screening marches every numerical object in one batch
    return anchored(obj, sess.anchor_epoch_unix)


def time_of_closest_pass(primary: OrbitalObject, now_unix: float, lat_deg: float, lon_deg: float, horizon_s: float,
                         step_s: float = 10.0) -> float:
    """When the primary's ground track passes closest to a geographic point (first pass preferred)."""
    times = now_unix + np.arange(MIN_TIME_TO_TCA_S, max(horizon_s, MIN_TIME_TO_TCA_S + step_s), step_s)
    res = propagate(primary, times)
    target = np.radians([lat_deg, lon_deg])
    best_t, best_d = float(times[0]), np.inf
    for t, r in zip(times, res.positions_km):
        if not np.isfinite(r).all():
            continue
        geo = ecef_to_geodetic(teme_to_ecef(r, float(t)))
        lat, lon = np.radians(geo["lat_deg"]), np.radians(geo["lon_deg"])
        # great-circle angle between the sub-satellite point and the target
        d = np.arccos(np.clip(np.sin(lat) * np.sin(target[0]) + np.cos(lat) * np.cos(target[0]) * np.cos(lon - target[1]), -1.0, 1.0))
        if d < best_d - 1e-9:
            best_d, best_t = d, float(t)
    return best_t


# --------------------------------------------------------------------------
# spawning
# --------------------------------------------------------------------------

def spawn(sess: SimulationSession, now_unix: float, spec: SpawnSpec) -> Dict[str, Any]:
    """Add one junk object of the given kind whose closest approach to the primary is designed from the
    spec (or drawn from the kind's band). Returns the object, the designed encounter and the new state."""
    _require_sandbox(sess)
    settings = get_settings()
    jt = JUNK_TYPES.get(spec.kind)
    if jt is None:
        raise service.BadRequest(f"unknown junk kind '{spec.kind}'; one of {', '.join(JUNK_TYPES)}")
    if spec.axis not in ("horizontal", "radial"):
        raise service.BadRequest("axis must be 'horizontal' or 'radial'")
    now = float(now_unix)
    with sess.lock:
        if len(sess.spawned_ids) >= settings.sandbox_max_objects:
            raise service.Conflict(f"the sandbox holds at most {settings.sandbox_max_objects} spawned objects; reset to clear them")
        scen = sess.scenario
        primary = scen.catalog.require(scen.primary_id)
        period = primary.period_s or 5600.0
        seed = int(spec.seed) if spec.seed is not None else sess.next_seed()
        rng = np.random.default_rng(seed)
        if spec.drop_point is not None:
            lat, lon = float(spec.drop_point[0]), float(spec.drop_point[1])
            t_tca = time_of_closest_pass(primary, now, lat, lon, 2.0 * period)
        elif spec.time_to_tca_s is not None:
            t_tca = now + float(spec.time_to_tca_s)
        else:
            t_tca = now + float(rng.uniform(RANDOM_MIN_LEAD_S, 2.0 * period))
        if t_tca - now < MIN_TIME_TO_TCA_S:
            raise service.BadRequest(f"the closest approach must be at least {MIN_TIME_TO_TCA_S:.0f} s ahead")
        miss = float(spec.offset_km) if spec.offset_km is not None else float(rng.uniform(*jt.miss_band_km))
        if spec.axis == "radial":
            miss_h, miss_r = 0.0, miss
        else:
            miss_r = miss * float(rng.uniform(*jt.radial_fraction))
            miss_h = float(np.sqrt(max(miss * miss - miss_r * miss_r, 0.0)))
        if spec.crossing_angle_deg is not None:
            crossing = float(spec.crossing_angle_deg)
        else:
            crossing = float(rng.uniform(*jt.crossing_deg)) * float(rng.choice([-1.0, 1.0]))
        speed_factor = float(rng.uniform(*jt.speed_factor))
        try:
            r_now, v_now, designed = construct_encounter(primary, now, t_tca, miss_h, miss_r, crossing, speed_factor,
                                                         settings.planner_numerical_step_s)
        except ValueError as exc:
            raise service.BadRequest(str(exc)) from exc
        obj = make_junk_object(sess, spec.kind, r_now, v_now, now, designed, name=spec.name, seed=seed)
        scen.catalog.add(obj)
        scen.rendered_object_ids.append(obj.object_id)
        sess.spawned_ids.append(obj.object_id)
        sess.clock_unix = now
        minutes = designed["time_to_tca_s"] / 60.0
        event = sess.add_event("SPAWNED",
                               f"Spawned {jt.label.lower()} {obj.object_id}: closest approach in {minutes:.0f} min at "
                               f"{designed['miss_km']:.2f} km ({designed['relative_speed_kms']:.1f} km/s)",
                               at_unix=now, object_id=obj.object_id, junk_kind=spec.kind, tca_unix=designed["tca_unix"],
                               miss_km=designed["miss_km"])
        sess.invalidate_perception()
        designed_out = {**designed, "kind": spec.kind, "seed": seed, "band_km": list(jt.miss_band_km)}
        return {"object": obj.summary(), "designed": designed_out, "spawned_at": iso(now),
                "catalog_version": sess.catalog_version, "events": [event], "simulation": sess.state_summary()}


def spawn_random(sess: SimulationSession, now_unix: float, count: int, seed: Optional[int] = None) -> Dict[str, Any]:
    """Spawn ``count`` junk objects of mixed kinds with closest approaches spread over the next two orbits."""
    _require_sandbox(sess)
    settings = get_settings()
    if not 1 <= int(count) <= MAX_RANDOM_COUNT:
        raise service.BadRequest(f"count must be between 1 and {MAX_RANDOM_COUNT}")
    with sess.lock:
        if len(sess.spawned_ids) + int(count) > settings.sandbox_max_objects:
            raise service.Conflict(f"the sandbox holds at most {settings.sandbox_max_objects} spawned objects "
                                   f"({len(sess.spawned_ids)} already); reset to clear them")
        batch_seed = int(seed) if seed is not None else sess.next_seed()
        rng = np.random.default_rng(batch_seed)
        kinds = list(RANDOM_KIND_WEIGHTS)
        drawn = rng.choice(kinds, size=int(count), p=[RANDOM_KIND_WEIGHTS[k] for k in kinds])
        period = sess.scenario.catalog.require(sess.scenario.primary_id).period_s or 5600.0
        lo, hi = RANDOM_MIN_LEAD_S, 2.0 * period
        slots = np.linspace(lo, hi, int(count) + 2)[1:-1]
        jitter = rng.uniform(-0.3, 0.3, size=int(count)) * (hi - lo) / (int(count) + 1)
        objects, designed, events = [], [], []
        for k in range(int(count)):
            res = spawn(sess, now_unix, SpawnSpec(kind=str(drawn[k]), time_to_tca_s=float(slots[k] + jitter[k]),
                                                  seed=int(rng.integers(0, 2 ** 31 - 1))))
            objects.append(res["object"])
            designed.append(res["designed"])
            events.extend(res["events"])
        return {"objects": objects, "designed": designed, "seed": batch_seed, "catalog_version": sess.catalog_version,
                "events": events, "simulation": sess.state_summary()}


def remove(sess: SimulationSession, now_unix: float, object_ids: Optional[Sequence[str]] = None,
           count: Optional[int] = None) -> Dict[str, Any]:
    """Take spawned junk out of the sandbox: the given ids, or the ``count`` most recently spawned pieces.

    Their passes leave the screening; burns already committed to dodge them stay part of the trajectory
    (they were flown, or are about to be), and the event log says so."""
    _require_sandbox(sess)
    with sess.lock:
        if object_ids:
            ids = list(dict.fromkeys(object_ids))
            unknown = [i for i in ids if i not in sess.spawned_ids]
            if unknown:
                raise service.NotFound(f"not spawned junk: {', '.join(unknown)}")
        else:
            n = int(count or 1)
            if n < 1:
                raise service.BadRequest("count must be at least 1")
            ids = list(sess.spawned_ids[-n:])
        if not ids:
            return {"removed": [], "events": [], "catalog_version": sess.catalog_version, "simulation": sess.state_summary()}
        scen = sess.scenario
        for oid in ids:
            scen.catalog.remove(oid)
            scen.rendered_object_ids[:] = [x for x in scen.rendered_object_ids if x != oid]
            sess.spawned_ids.remove(oid)
        gone = set(ids)
        dropped = [cid for cid, c in sess.conjunctions.items() if c.secondary_id in gone]
        for cid in dropped:
            sess.conjunctions.pop(cid, None)
            plan = sess.plans.pop(cid, None)
            for mid in ([c.maneuver_id for c in plan.candidates] if plan else []):
                if not sess.is_committed(mid):
                    sess.maneuvers.pop(mid, None)
                    sess.secondary_checks.pop(mid, None)
        sess.unavoidable = {k: v for k, v in sess.unavoidable.items() if k[0] not in gone}
        sess.seen_passes = {k for k in sess.seen_passes if k[0] not in gone}
        if sess.screening is not None:
            sess.screening["conjunctions_found"] = len(sess.conjunctions)
        sess.clock_unix = float(now_unix)
        sess.last_evaluation = None
        kept_burns = [b.maneuver_id for b in sess.committed if (_secondary_of(sess, b) or "") in gone]
        note = f"; burn{'s' if len(kept_burns) != 1 else ''} {', '.join(kept_burns)} stay{'s' if len(kept_burns) == 1 else ''} in the trajectory" if kept_burns else ""
        event = sess.add_event("REMOVED", f"Removed {len(ids)} piece{'s' if len(ids) != 1 else ''} of junk: {', '.join(ids)}{note}",
                               at_unix=now_unix, object_ids=ids, kept_burns=kept_burns)
        sess.invalidate_perception()
        return {"removed": ids, "events": [event], "catalog_version": sess.catalog_version, "simulation": sess.state_summary()}


def junk_types() -> Dict[str, Any]:
    return {"kinds": [jt.to_dict() for jt in JUNK_TYPES.values()], "min_time_to_tca_s": MIN_TIME_TO_TCA_S,
            "max_random_count": MAX_RANDOM_COUNT, "max_objects": get_settings().sandbox_max_objects}


# --------------------------------------------------------------------------
# the autopilot loop
# --------------------------------------------------------------------------

def anchor_catalog(sess: SimulationSession, t_unix: float) -> int:
    """Move every numerical object's integration anchor to t_unix (the path is unchanged)."""
    catalog = sess.scenario.catalog
    n = 0
    for o in catalog.values():
        if o.propagation_model in (MODEL_NUMERICAL, MODEL_PIECEWISE):
            catalog.replace(anchored(o, float(t_unix)), bump_version=False)
            n += 1
    sess.anchor_epoch_unix = float(t_unix)
    sess.add_event("ANCHORED", f"Re-anchored {n} numerical states at {iso(t_unix)}", at_unix=t_unix, count=n)
    return n


def needs_mitigation(c: Conjunction, require_distance: bool, target_km: float) -> bool:
    if c.threat_state in ("CRITICAL", "ELEVATED"):
        return True
    return bool(require_distance and c.miss_distance_km < target_km)


def _pass_key(c: Conjunction) -> Tuple[str, int]:
    return c.secondary_id, int(round(c.tca_unix / 600.0))


def _leads_for(c: Conjunction, now: float, margin: float, period: float, prof) -> List[float]:
    """Profile leads that still fit before the pass, plus the as-soon-as-possible lead."""
    earliest = now + margin
    fits = [L for L in prof.lead_orbits if c.tca_unix - L * period >= earliest + 1.0]
    asap = (c.tca_unix - earliest) / period
    if asap * period >= prof.min_lead_time_s and (not fits or asap < min(fits)):
        fits.append(round(asap, 4))
    return sorted(set(fits))


def evaluate(sess: SimulationSession, now_unix: float, earliest_burn_after_s: Optional[float] = None) -> Dict[str, Any]:
    """Screen from ``now`` and let the autopilot plan, check and commit burns for every pass that needs
    mitigation (or, with the autopilot off, leave a plan waiting for approval)."""
    _require_sandbox(sess)
    settings = get_settings()
    prof = settings.sandbox_profile()
    now = float(now_unix)
    with sess.lock:
        last = sess.last_evaluation
        if (last is not None and sess.last_evaluation_result is not None
                and 0.0 <= now - last["now_unix"] < settings.sandbox_evaluate_min_interval_s
                and last["catalog_version"] == sess.catalog_version and last["primary_version"] == sess.primary_version
                and last["autopilot"] == sess.autopilot):
            return {**sess.last_evaluation_result, "cached": True}
        seq0 = sess.event_seq
        sess.clock_unix = now
        scen = sess.scenario
        primary = scen.catalog.require(scen.primary_id)
        period = primary.period_s or 5600.0
        anchored_n = 0
        if now - sess.anchor_epoch_unix >= settings.sandbox_anchor_every_s:
            anchored_n = anchor_catalog(sess, now - period)
        horizon_end = now + (prof.screening_horizon_orbits or 2.0) * period
        scr = service.run_screening(sess, start=iso(now), end=iso(horizon_end),
                                    pc_policy=sess.screening_pc_policy or scen.pc_policy)
        for c in sess.ranked_conjunctions():
            key = _pass_key(c)
            if key not in sess.seen_passes:
                sess.seen_passes.add(key)
                sec = scen.catalog.get(c.secondary_id)
                sess.add_event("CLOSEST_APPROACH",
                               f"{sec.name if sec else c.secondary_id}: closest approach in {(c.tca_unix - now) / 60.0:.0f} min "
                               f"at {c.miss_distance_km:.2f} km, state {c.threat_state}",
                               at_unix=now, object_id=c.secondary_id, conjunction_id=c.conjunction_id,
                               tca_unix=float(c.tca_unix), miss_km=float(c.miss_distance_km), threat_state=c.threat_state)
        margin = max(prof.earliest_burn_margin_s, float(earliest_burn_after_s or 0.0))
        actions: List[Dict[str, Any]] = []
        handled: set = set()
        burns_done = 0

        def pending() -> List[Conjunction]:
            return sorted((c for c in sess.conjunctions.values()
                           if c.tca_unix > now and _pass_key(c) not in handled
                           and needs_mitigation(c, prof.require_distance_target, settings.miss_distance_target_km)),
                          key=lambda c: c.tca_unix)

        def action(c: Conjunction, outcome: str, **extra: Any) -> None:
            actions.append({"conjunction_id": c.conjunction_id, "secondary_id": c.secondary_id, "tca": iso(c.tca_unix),
                            "tca_unix": float(c.tca_unix), "miss_km": float(c.miss_distance_km),
                            "threat_state": c.threat_state, "outcome": outcome, "maneuver_id": None,
                            "post_miss_km": None, "reason": None, **extra})

        def unavoidable(c: Conjunction, reason: str) -> None:
            key = _pass_key(c)
            if key not in sess.unavoidable:
                sess.add_event("UNAVOIDABLE", f"Could not avoid {c.secondary_id} (closest approach {iso(c.tca_unix)}): {reason}",
                               at_unix=now, object_id=c.secondary_id, conjunction_id=c.conjunction_id, reason=reason)
            sess.unavoidable[key] = {"at": now, "reason": reason, "conjunction_id": c.conjunction_id}
            action(c, "UNAVOIDABLE", reason=reason)

        while True:
            todo = pending()
            if not todo:
                break
            c = todo[0]
            key = _pass_key(c)
            handled.add(key)
            prior = sess.unavoidable.get(key)
            if prior is not None and now - prior["at"] < settings.sandbox_unavoidable_retry_s:
                action(c, "UNAVOIDABLE", reason=prior["reason"])
                continue
            if c.tca_unix <= now + margin + prof.min_lead_time_s:
                unavoidable(c, f"too late: the closest approach is {c.tca_unix - now:.0f} s away and the autopilot "
                               f"needs at least {margin + prof.min_lead_time_s:.0f} s to plan and burn")
                continue
            if burns_done >= settings.sandbox_max_burns_per_evaluate:
                action(c, "DEFERRED", reason="burn budget for this evaluation used; next evaluation continues")
                continue
            leads = _leads_for(c, now, margin, period, prof)
            if not leads:
                unavoidable(c, "no lead time fits before the pass")
                continue
            if not sess.autopilot:
                plan = sess.plans.get(c.conjunction_id)
                if plan is None:
                    try:
                        plan_d = service.plan_for_conjunction(sess, c.conjunction_id, max_candidates=3, profile=prof,
                                                              lead_orbits=leads)
                    except service.BadRequest as exc:
                        unavoidable(c, f"planning failed: {exc}")
                        continue
                    plan = sess.plans[c.conjunction_id]
                    sess.add_event("AWAITING_APPROVAL",
                                   f"Autopilot off: {len(plan.recommended_ids)} burn(s) planned for {c.secondary_id}, waiting for approval",
                                   at_unix=now, conjunction_id=c.conjunction_id, object_id=c.secondary_id,
                                   maneuver_ids=list(plan.recommended_ids))
                rec = plan.recommended_ids[0] if plan.recommended_ids else None
                action(c, "AWAITING_APPROVAL" if rec else "UNAVOIDABLE", maneuver_id=rec,
                       post_miss_km=float(sess.maneuvers[rec].post_miss_distance_km) if rec else None,
                       reason=None if rec else "no feasible burn meets both targets")
                continue
            try:
                service.plan_for_conjunction(sess, c.conjunction_id, max_candidates=2, profile=prof, lead_orbits=leads)
            except service.BadRequest as exc:
                unavoidable(c, f"planning failed: {exc}")
                continue
            plan = sess.plans[c.conjunction_id]
            chosen = None
            why = "no feasible burn meets both the probability and the distance target"
            for mid in plan.recommended_ids:
                cand = sess.maneuvers[mid]
                if not (cand.feasible and cand.meets_target):
                    continue
                try:
                    check = service.run_secondary_check(sess, mid, window_end_unix=horizon_end)
                except service.Conflict as exc:
                    why = str(exc)
                    continue
                worst = max(ORDER.index(check["worst_new_state"]), ORDER.index(check.get("worst_changed_state", "NORMAL")))
                if check["validation_status"] in ("PASS", "LIMITED") and worst <= ORDER.index("MONITORING"):
                    chosen = mid
                    break
                spoiled = check.get("spoiled_passes") or []
                why = (f"{mid} would bring {spoiled[0]['secondary_id']} inside the distance target "
                       f"({spoiled[0]['after_miss_km']:.2f} km)" if spoiled
                       else f"{mid} would create a new close approach (worst new state {check['worst_new_state']})"
                       if check["validation_status"] == "FAIL" else f"{mid} failed the secondary check")
            if chosen is None:
                unavoidable(c, why)
                continue
            try:
                res = service.commit(sess, chosen, now_unix=now, source="autopilot")
            except service.Conflict as exc:
                unavoidable(c, f"commit refused: {exc}")
                continue
            burns_done += 1
            cand = sess.maneuvers[chosen]
            action(c, "COMMITTED", maneuver_id=chosen, post_miss_km=float(cand.post_miss_distance_km),
                   burn_time=iso(cand.burn_time_unix), burn_time_unix=float(cand.burn_time_unix),
                   direction=cand.direction, dv_mps=float(cand.dv_magnitude_mps),
                   secondary_check=res["secondary_check"]["validation_status"])
        for c in sess.ranked_conjunctions():
            if _pass_key(c) in handled or c.tca_unix <= now:
                continue
            mitigated = any(b.candidate.conjunction_id == c.conjunction_id or
                            (sess.conjunctions.get(b.candidate.conjunction_id) is None and
                             abs(b.candidate.post_tca_unix - c.tca_unix) <= 600.0 and
                             sess.scenario.catalog.get(c.secondary_id) is not None and
                             _secondary_of(sess, b) == c.secondary_id)
                            for b in sess.committed)
            if mitigated:
                action(c, "MITIGATED")
        state = sess.state_summary()
        result = {
            "scenario_id": sess.scenario_id, "now": iso(now), "now_unix": now, "cached": False, "anchored": anchored_n,
            "screening": {"start": iso(now), "end": iso(horizon_end), "conjunctions_found": len(sess.conjunctions),
                          "stats": scr["stats"]},
            "conjunctions": [service.get_conjunction(sess, c.conjunction_id) for c in sess.ranked_conjunctions()],
            "actions": actions, "committed_maneuvers": state["committed_maneuvers"],
            "events_added": [e for e in sess.events if e["seq"] > seq0], "simulation": state,
        }
        sess.last_evaluation = {"now": iso(now), "now_unix": now, "catalog_version": sess.catalog_version,
                                "primary_version": sess.primary_version, "autopilot": sess.autopilot,
                                "actions": [{k: a[k] for k in ("secondary_id", "outcome", "maneuver_id", "reason")} for a in actions],
                                "conjunctions_found": len(sess.conjunctions), "anchored": anchored_n}
        sess.last_evaluation_result = result
        return result


def _secondary_of(sess: SimulationSession, burn) -> Optional[str]:
    """The secondary a committed burn was planned against (its conjunction id embeds it)."""
    cid = burn.candidate.conjunction_id
    c = sess.conjunctions.get(cid)
    if c is not None:
        return c.secondary_id
    for key, rec in sess.unavoidable.items():
        if rec.get("conjunction_id") == cid:
            return key[0]
    # CJ-{primary}-{secondary}-{tca}: strip the known primary prefix and the trailing time
    prefix = f"CJ-{sess.scenario.primary_id.replace('NORAD-', '')}-"
    if cid.startswith(prefix):
        body = cid[len(prefix):]
        return body.rsplit("-", 1)[0]
    return None
