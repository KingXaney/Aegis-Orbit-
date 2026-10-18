"""Candidate avoidance-maneuver planner (deterministic grid search).

For each configured lead time before the closest approach (expressed in
orbital periods of the primary) the planner:

1. takes the primary's state at the burn time from its *native* model (SGP4
   for catalog objects, two-body + J2 for synthetic states);
2. builds an impulsive delta-v grid in the local RTN frame (configured
   directions x magnitudes) plus a zero-delta-v baseline;
3. propagates all post-burn states together with the two-body + J2 RK4 model
   to a dense grid around the original TCA, locates each candidate's new
   closest approach to the secondary (which keeps its native model) and
   refines it with a bounded minimisation;
4. recomputes the miss distance and, when covariances exist, the collision
   probability with the covariance assumed unchanged by the burn;
5. rejects infeasible candidates (delta-v budget, minimum lead time, burn
   before the allowed start) and ranks the rest with the documented objective.

Model consistency: the zero-delta-v baseline is propagated with the same
numerical model as the candidates, so ``baseline`` reports how far the
numerical model drifts from the screening result (native models) at each
lead time. That difference is a model artefact, not a maneuver effect, and is
reported rather than hidden.

Objective (lower is better):

    J = |dv| / dv_budget                       (cost, 0..1)
      + max(0, log10(Pc_post / Pc_target))      (orders of magnitude above target; Pc available)
        or max(0, (miss_target - miss_post) / miss_target)   (no covariance)
      + 1000 if infeasible

Candidates meeting the target therefore compete on delta-v alone; ties are
broken by larger post-maneuver miss distance, then earlier burn. The target
(Pc <= pc_mitigation_target, or miss >= miss_distance_target_km without
covariance) is a configurable demonstration setting.
"""
from __future__ import annotations

import time as _time
from dataclasses import dataclass, field, replace
from typing import Any, Dict, List, Optional, Sequence

import numpy as np
from scipy.optimize import minimize_scalar

from ..config import PlannerProfile, Settings, get_settings
from ..data.catalog import OrbitalObject, Segment
from .collision_probability import POLICY_PROVIDED_ONLY, PcResult, compute_pc
from .frames import osculating_elements, rtn_basis
from .propagation import MODEL_PIECEWISE, original_of, propagate, propagate_states, state_at
from .screening import Conjunction, anchor
from .threat import evaluate_threat_state, meets_mitigation_target
from .time_utils import iso

DIRECTION_VECTORS = {
    "+T": np.array([0.0, 1.0, 0.0]), "-T": np.array([0.0, -1.0, 0.0]),
    "+R": np.array([1.0, 0.0, 0.0]), "-R": np.array([-1.0, 0.0, 0.0]),
    "+N": np.array([0.0, 0.0, 1.0]), "-N": np.array([0.0, 0.0, -1.0]),
}
DIRECTION_LABELS = {"+T": "along-track (prograde)", "-T": "along-track (retrograde)", "+R": "radial out",
                    "-R": "radial in", "+N": "cross-track (+normal)", "-N": "cross-track (-normal)"}
POST_BURN_MODEL = "two-body + J2, RK4 fixed step"
PLANNER_ASSUMPTIONS = [
    "impulsive burn (instantaneous velocity change)",
    "post-burn trajectory propagated with two-body + J2 only (no drag, no higher-order harmonics)",
    "secondary object keeps its native propagation model",
    "position covariance assumed unchanged by the maneuver (no execution error modelled)",
    "delta-v budget is a configured proxy for propellant, not a measured tank state",
]


@dataclass
class ManeuverCandidate:
    maneuver_id: str
    conjunction_id: str
    burn_time_unix: float
    lead_time_s: float
    lead_orbits: float
    direction: str
    dv_rtn_mps: np.ndarray
    dv_teme_mps: np.ndarray
    dv_magnitude_mps: float
    burn_r_km: np.ndarray
    burn_v_pre_kms: np.ndarray
    burn_v_post_kms: np.ndarray
    post_tca_unix: float
    post_miss_distance_km: float
    post_relative_speed_kms: float
    post_relative_position_teme_km: np.ndarray
    post_relative_velocity_teme_kms: np.ndarray
    post_primary_r_km: np.ndarray
    post_primary_v_kms: np.ndarray
    post_secondary_r_km: np.ndarray
    post_secondary_v_kms: np.ndarray
    post_pc: Optional[PcResult]
    post_threat_state: str
    post_threat_rationale: List[str]
    baseline_miss_distance_km: float
    screening_miss_distance_km: float
    meets_target: bool
    target_basis: str
    feasible: bool
    feasibility_reasons: List[str]
    validation_status: str  # VALID | REJECTED
    objective_score: float
    objective_terms: Dict[str, float]
    propagation_model: str = POST_BURN_MODEL
    assumptions: List[str] = field(default_factory=lambda: list(PLANNER_ASSUMPTIONS))
    fuel_proxy: Dict[str, float] = field(default_factory=dict)
    rank: Optional[int] = None
    secondary_check: Optional[Dict[str, Any]] = None
    primary_version: Optional[int] = None  # the session's primary version this candidate was planned against

    def to_dict(self) -> Dict[str, Any]:
        return {
            "maneuver_id": self.maneuver_id,
            "conjunction_id": self.conjunction_id,
            "burn_time": iso(self.burn_time_unix),
            "burn_time_unix": self.burn_time_unix,
            "lead_time_s": self.lead_time_s,
            "lead_orbits": self.lead_orbits,
            "direction": self.direction,
            "direction_label": DIRECTION_LABELS.get(self.direction, self.direction),
            "dv_rtn_mps": [float(x) for x in self.dv_rtn_mps],
            "dv_teme_mps": [float(x) for x in self.dv_teme_mps],
            "dv_magnitude_mps": float(self.dv_magnitude_mps),
            "burn_state_teme": {"r_km": [float(x) for x in self.burn_r_km],
                                "v_pre_kms": [float(x) for x in self.burn_v_pre_kms],
                                "v_post_kms": [float(x) for x in self.burn_v_post_kms]},
            "post_tca": iso(self.post_tca_unix),
            "post_tca_unix": self.post_tca_unix,
            "post_miss_distance_km": float(self.post_miss_distance_km),
            "post_relative_speed_kms": float(self.post_relative_speed_kms),
            "post_relative_position_teme_km": [float(x) for x in self.post_relative_position_teme_km],
            "post_primary_state_teme": {"r_km": [float(x) for x in self.post_primary_r_km],
                                        "v_kms": [float(x) for x in self.post_primary_v_kms]},
            "post_secondary_state_teme": {"r_km": [float(x) for x in self.post_secondary_r_km],
                                          "v_kms": [float(x) for x in self.post_secondary_v_kms]},
            "post_pc": self.post_pc.to_dict() if self.post_pc else None,
            "post_threat_state": self.post_threat_state,
            "post_threat_rationale": list(self.post_threat_rationale),
            "baseline_miss_distance_km": float(self.baseline_miss_distance_km),
            "screening_miss_distance_km": float(self.screening_miss_distance_km),
            "miss_distance_change_km": float(self.post_miss_distance_km - self.baseline_miss_distance_km),
            "meets_target": self.meets_target,
            "target_basis": self.target_basis,
            "feasible": self.feasible,
            "feasibility_reasons": list(self.feasibility_reasons),
            "validation_status": self.validation_status,
            "objective_score": float(self.objective_score),
            "objective_terms": {k: float(v) for k, v in self.objective_terms.items()},
            "propagation_model": self.propagation_model,
            "assumptions": list(self.assumptions),
            "fuel_proxy": self.fuel_proxy,
            "rank": self.rank,
            "secondary_check": self.secondary_check,
            "primary_version": self.primary_version,
        }


@dataclass
class PlanResult:
    conjunction_id: str
    candidates: List[ManeuverCandidate]
    recommended_ids: List[str]
    baseline: List[Dict[str, Any]]
    config: Dict[str, Any]
    objective: str
    stats: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "conjunction_id": self.conjunction_id,
            "candidates": [c.to_dict() for c in self.candidates],
            "recommended_ids": list(self.recommended_ids),
            "baseline": self.baseline,
            "config": self.config,
            "objective": self.objective,
            "assumptions": list(PLANNER_ASSUMPTIONS),
            "stats": self.stats,
        }


OBJECTIVE_TEXT = ("J = |dv|/dv_budget + max(0, log10(Pc_post/Pc_target)) [or distance shortfall when Pc is "
                  "unavailable] + 1000 if infeasible; lowest J wins, ties broken by larger post-maneuver miss "
                  "distance then earlier burn. Target values are configurable demonstration settings.")


def _refine_candidate(state_p: np.ndarray, t_anchor: float, secondary: OrbitalObject, t_lo: float, t_hi: float,
                      step_s: float) -> Dict[str, Any]:
    """Exact closest approach of a numerically propagated primary state (anchored at t_anchor)
    to the secondary within [t_lo, t_hi]."""
    sec = anchor(secondary, t_lo, step_s)

    def states(t: float):
        yp = propagate_states(state_p[None, :], t_anchor, np.array([t]), step_s)[0, 0]
        rs = propagate(sec, np.array([t]), step_s)
        return yp[:3], yp[3:], rs.positions_km[0], rs.velocities_kms[0]

    def dist(tau: float) -> float:
        rp, _, rs, _ = states(t_lo + tau)
        return float(np.linalg.norm(rs - rp))

    res = minimize_scalar(dist, bounds=(0.0, t_hi - t_lo), method="bounded", options={"xatol": 1e-3})
    t_star = float(t_lo + res.x)
    rp, vp, rs, vs = states(t_star)
    return {"tca": t_star, "rp": rp, "vp": vp, "rs": rs, "vs": vs, "rel_r": rs - rp, "rel_v": vs - vp,
            "miss_km": float(np.linalg.norm(rs - rp)), "rel_speed": float(np.linalg.norm(vs - vp))}


def plan_maneuvers(conj: Conjunction, primary: OrbitalObject, secondary: OrbitalObject,
                   window_start_unix: float, earliest_burn_unix: Optional[float] = None,
                   settings: Optional[Settings] = None, pc_policy: str = POLICY_PROVIDED_ONLY,
                   max_candidates: int = 3, lead_orbits: Optional[Sequence[float]] = None,
                   dv_magnitudes_mps: Optional[Sequence[float]] = None,
                   directions: Optional[Sequence[str]] = None, profile: Optional[PlannerProfile] = None) -> PlanResult:
    s = settings or get_settings()
    prof = profile or s.default_profile()
    t_wall = _time.time()
    leads = list(lead_orbits if lead_orbits is not None else prof.lead_orbits)
    mags = list(dv_magnitudes_mps if dv_magnitudes_mps is not None else prof.dv_magnitudes_mps)
    dirs = [d for d in (directions if directions is not None else prof.directions) if d in DIRECTION_VECTORS]
    max_dv = prof.max_dv_mps
    min_lead = prof.min_lead_time_s
    require_distance = prof.require_distance_target
    step = s.planner_numerical_step_s
    period = primary.period_s or 5600.0
    earliest = max(window_start_unix, earliest_burn_unix if earliest_burn_unix is not None else window_start_unix)
    tca = conj.tca_unix
    search_half_width_s = 180.0
    grid = tca + np.arange(-search_half_width_s, search_half_width_s + 1e-6, 2.0)
    sec_grid = propagate(secondary, grid, step)
    if sec_grid.status != "OK":
        raise ValueError(f"secondary {secondary.object_id} could not be propagated around TCA: {sec_grid.messages}")

    candidates: List[ManeuverCandidate] = []
    baseline_rows: List[Dict[str, Any]] = []
    short_sec = secondary.object_id.replace("NORAD-", "").replace("SYN-", "").replace("SBX-", "")
    # Ids carry the encounter time, so plans for different passes of the same object never collide.
    id_prefix = f"MV-{short_sec}-{int(round(tca))}"
    n = 0
    for lead in leads:
        t_burn = tca - lead * period
        lead_reasons: List[str] = []
        if t_burn < earliest:
            lead_reasons.append(f"burn time {iso(t_burn)} is before the earliest allowed burn {iso(earliest)}")
        if tca - t_burn < min_lead:
            lead_reasons.append(f"lead time {tca - t_burn:.0f} s is below the minimum {min_lead:.0f} s")
        try:
            r_b, v_b = state_at(primary, t_burn, step)
        except ValueError as exc:
            baseline_rows.append({"lead_orbits": lead, "burn_time": iso(t_burn), "error": str(exc)})
            continue
        basis = rtn_basis(r_b, v_b)
        combos = [("baseline", np.zeros(3), 0.0)]
        for d in dirs:
            for m in mags:
                combos.append((d, DIRECTION_VECTORS[d] * m, m))
        states0 = np.empty((len(combos), 6))
        for k, (_, dv_rtn, _) in enumerate(combos):
            dv_teme_kms = basis @ dv_rtn / 1000.0
            states0[k, :3] = r_b
            states0[k, 3:] = v_b + dv_teme_kms
        ys = propagate_states(states0, t_burn, grid, step)  # (M, K, 6)
        rel = sec_grid.positions_km[:, None, :] - ys[:, :, :3]
        dist = np.linalg.norm(rel, axis=2)  # (M, K)
        baseline_miss = None
        for k, (d, dv_rtn, m) in enumerate(combos):
            i_min = int(np.argmin(dist[:, k]))
            i_lo, i_hi = max(i_min - 1, 0), min(i_min + 1, len(grid) - 1)
            ref = _refine_candidate(ys[i_lo, k], float(grid[i_lo]), secondary, float(grid[i_lo]), float(grid[i_hi]), step)
            if d == "baseline":
                baseline_miss = ref["miss_km"]
                baseline_rows.append({
                    "lead_orbits": lead, "burn_time": iso(t_burn),
                    "numerical_zero_dv_miss_km": ref["miss_km"], "numerical_zero_dv_tca": iso(ref["tca"]),
                    "screening_miss_km": float(conj.miss_distance_km), "screening_tca": iso(tca),
                    "model_difference_km": float(ref["miss_km"] - conj.miss_distance_km),
                    "note": "difference between the two-body+J2 model and the screening models for the "
                            "un-maneuvered primary; a model artefact, not a maneuver effect",
                })
                continue
            n += 1
            dv_teme = basis @ dv_rtn
            pc = compute_pc(ref["rel_r"], ref["rel_v"], ref["rp"], ref["vp"], ref["rs"], ref["vs"], primary, secondary,
                            policy=pc_policy,
                            extra_assumptions=["covariance assumed unchanged by the maneuver"])
            state, rationale = evaluate_threat_state(ref["miss_km"], pc, s)
            meets, basis_txt = meets_mitigation_target(ref["miss_km"], pc, s, require_distance=require_distance)
            reasons = list(lead_reasons)
            if m > max_dv:
                reasons.append(f"delta-v {m:g} m/s exceeds budget {max_dv:g} m/s")
            feasible = not reasons
            cost = m / max_dv
            shortfall = max(0.0, (s.miss_distance_target_km - ref["miss_km"]) / s.miss_distance_target_km)
            if pc.status == "COMPUTED" and pc.value is not None:
                risk = max(0.0, np.log10(max(pc.value, 1e-300) / s.pc_mitigation_target))
                if require_distance:
                    risk += shortfall
            else:
                risk = shortfall
            penalty = 0.0 if feasible else 1000.0
            score = cost + risk + penalty
            candidates.append(ManeuverCandidate(
                maneuver_id=f"{id_prefix}-{n:03d}", conjunction_id=conj.conjunction_id,
                burn_time_unix=t_burn, lead_time_s=tca - t_burn, lead_orbits=lead, direction=d,
                dv_rtn_mps=dv_rtn, dv_teme_mps=dv_teme, dv_magnitude_mps=m,
                burn_r_km=r_b, burn_v_pre_kms=v_b, burn_v_post_kms=states0[k, 3:],
                post_tca_unix=ref["tca"], post_miss_distance_km=ref["miss_km"], post_relative_speed_kms=ref["rel_speed"],
                post_relative_position_teme_km=ref["rel_r"], post_relative_velocity_teme_kms=ref["rel_v"],
                post_primary_r_km=ref["rp"], post_primary_v_kms=ref["vp"], post_secondary_r_km=ref["rs"],
                post_secondary_v_kms=ref["vs"], post_pc=pc, post_threat_state=state, post_threat_rationale=rationale,
                baseline_miss_distance_km=float(baseline_miss if baseline_miss is not None else conj.miss_distance_km),
                screening_miss_distance_km=float(conj.miss_distance_km),
                meets_target=bool(meets), target_basis=basis_txt, feasible=feasible, feasibility_reasons=reasons,
                validation_status="VALID" if feasible else "REJECTED", objective_score=float(score),
                objective_terms={"dv_cost": cost, "risk_term": float(risk), "infeasible_penalty": penalty},
                fuel_proxy={"dv_budget_mps": max_dv, "fraction_of_budget": float(m / max_dv)},
            ))

    candidates.sort(key=lambda c: (c.objective_score, -c.post_miss_distance_km, c.burn_time_unix))
    for i, c in enumerate(candidates):
        c.rank = i + 1
    recommended = _select_diverse(candidates, max_candidates)
    stats = {"candidates_evaluated": len(candidates), "valid": sum(1 for c in candidates if c.feasible),
             "meeting_target": sum(1 for c in candidates if c.meets_target and c.feasible),
             "duration_s": round(_time.time() - t_wall, 3)}
    config = {"profile": prof.name, "lead_orbits": leads, "dv_magnitudes_mps": mags, "directions": dirs,
              "dv_budget_mps": max_dv, "min_lead_time_s": min_lead, "require_distance_target": require_distance,
              "numerical_step_s": step, "pc_policy": pc_policy,
              "earliest_burn": iso(earliest), "pc_mitigation_target": s.pc_mitigation_target,
              "miss_distance_target_km": s.miss_distance_target_km, "post_tca_search_half_width_s": search_half_width_s}
    return PlanResult(conj.conjunction_id, candidates, [c.maneuver_id for c in recommended], baseline_rows, config,
                      OBJECTIVE_TEXT, stats)


def _select_diverse(candidates: List[ManeuverCandidate], n: int) -> List[ManeuverCandidate]:
    """Top-n feasible candidates meeting the target, preferring distinct burn directions
    so the comparison shows real trade-offs; filled with the next best if needed."""
    passing = [c for c in candidates if c.feasible and c.meets_target]
    chosen: List[ManeuverCandidate] = []
    seen = set()
    for c in passing:
        if c.direction not in seen:
            chosen.append(c)
            seen.add(c.direction)
        if len(chosen) >= n:
            return chosen
    for c in passing:
        if c not in chosen:
            chosen.append(c)
        if len(chosen) >= n:
            return chosen
    for c in candidates:
        if c.feasible and c not in chosen:
            chosen.append(c)
        if len(chosen) >= n:
            break
    return chosen


# --------------------------------------------------------------------------
# Committing burns: the primary with its burn arcs (see propagation.MODEL_PIECEWISE)
# --------------------------------------------------------------------------

def burn_segment(primary: OrbitalObject, t_burn_unix: float, dv_rtn_mps, maneuver_id: str, direction: str = "",
                 step_s: float = 10.0) -> Segment:
    """A burn arc: the primary's state at the burn time plus an impulsive RTN delta-v (m/s)."""
    r_b, v_b = state_at(primary, float(t_burn_unix), step_s)
    dv = np.asarray(dv_rtn_mps, dtype=float)
    dv_teme_kms = rtn_basis(r_b, v_b) @ dv / 1000.0
    return Segment(t_start_unix=float(t_burn_unix), epoch_unix=float(t_burn_unix),
                   r0_km=np.asarray(r_b, float).copy(), v0_kms=np.asarray(v_b, float) + dv_teme_kms,
                   maneuver_id=maneuver_id, dv_mps=float(np.linalg.norm(dv)), direction=direction)


def _orbit_summary(r_km: np.ndarray, v_kms: np.ndarray) -> Dict[str, float]:
    el = osculating_elements(r_km, v_kms)
    return {"perigee_alt_km": el["perigee_alt_km"], "apogee_alt_km": el["apogee_alt_km"], "period_s": el["period_s"],
            "inclination_deg": el["inclination_deg"]}


def with_segment(primary: OrbitalObject, seg: Segment) -> OrbitalObject:
    """The primary with one more committed burn arc (a new object; the input is never mutated).

    Burns are append-only in time: a burn earlier than the last committed one would invalidate the
    arcs after it, so it is rejected and the caller has to re-plan from the committed path."""
    if primary.segments and seg.t_start_unix <= primary.segments[-1].t_start_unix:
        raise ValueError(f"burn at {iso(seg.t_start_unix)} is not after the last committed burn at "
                         f"{iso(primary.segments[-1].t_start_unix)}")
    first = primary.propagation_model != MODEL_PIECEWISE
    ids = [s.maneuver_id for s in primary.segments] + [seg.maneuver_id]
    base_summary = {"perigee_alt_km": primary.perigee_alt_km, "apogee_alt_km": primary.apogee_alt_km,
                    "period_s": primary.period_s, "inclination_deg": primary.inclination_deg}
    return replace(primary, propagation_model=MODEL_PIECEWISE,
                   base_model=primary.propagation_model if first else primary.base_model,
                   base_position_basis=primary.position_basis if first else primary.base_position_basis,
                   base_summary=base_summary if first else primary.base_summary,
                   segments=primary.segments + (seg,),
                   position_basis=f"POST_BURN_NUMERICAL ({'; '.join(ids)})",
                   warnings=list(primary.warnings), **_orbit_summary(seg.r0_km, seg.v0_kms))


def with_burn(primary: OrbitalObject, cand: ManeuverCandidate) -> OrbitalObject:
    """The primary with the candidate's burn committed (its post-burn state starts a new arc)."""
    seg = Segment(t_start_unix=float(cand.burn_time_unix), epoch_unix=float(cand.burn_time_unix),
                  r0_km=np.asarray(cand.burn_r_km, float).copy(), v0_kms=np.asarray(cand.burn_v_post_kms, float).copy(),
                  maneuver_id=cand.maneuver_id, dv_mps=float(cand.dv_magnitude_mps), direction=cand.direction)
    return with_segment(primary, seg)


def without_last_burn(primary: OrbitalObject) -> OrbitalObject:
    """The primary with its last committed burn removed (the original object once none remain)."""
    if not primary.segments:
        return primary
    segments = primary.segments[:-1]
    if not segments:
        return original_of(primary)
    last = segments[-1]
    ids = [s.maneuver_id for s in segments]
    return replace(primary, segments=segments, position_basis=f"POST_BURN_NUMERICAL ({'; '.join(ids)})",
                   warnings=list(primary.warnings), **_orbit_summary(last.r0_km, last.v0_kms))


def before_burn(primary: OrbitalObject, maneuver_id: str) -> OrbitalObject:
    """The primary as it flew before ``maneuver_id``: its native arc plus only the burns committed earlier
    (what a ghost of the spacecraft flies after that burn). Rebuilt arc by arc with ``with_segment`` so the
    orbit summary and basis match; re-anchored epochs stay valid because an anchor never leaves its own arc."""
    ids = [s.maneuver_id for s in primary.segments]
    if maneuver_id not in ids:
        raise ValueError(f"{maneuver_id} is not a committed burn of {primary.object_id}")
    obj = original_of(primary)
    for seg in primary.segments[: ids.index(maneuver_id)]:
        obj = with_segment(obj, seg)
    return obj


# Older name, kept for callers that preview a candidate on top of the current primary.
maneuvered_primary = with_burn
