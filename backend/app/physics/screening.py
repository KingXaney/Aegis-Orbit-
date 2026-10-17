"""Conjunction screening.

Pipeline for ``screen(primary, objects, window)``:

1. Coarse candidate filter: an object is kept when its perigee/apogee band,
   widened by a margin, overlaps the primary's band. Instantaneous altitude is
   never used, so objects on crossing eccentric orbits are retained.
2. Batch propagation of the primary and all candidates on a coarse time grid.
3. Relative distance series per pair; sample-level local minima below the
   screening radius (plus a step-dependent margin) are bracketed.
4. Each bracket is refined with a bounded scalar minimisation of the exact
   inter-object distance, evaluated with the objects' own propagation models.
5. Pairs whose relative speed at the minimum is below a small threshold are
   classified as co-orbital (docked / formation flying) and excluded.
6. Duplicate detections of the same encounter are merged; results are ranked
   by miss distance, then by time.

Limitations (documented, acceptable for a hackathon-sized catalog): an
encounter whose distance minimum is narrower than the coarse step and
immediately adjacent to another minimum could be merged with it; the
coarse step must be small compared with the orbital period.
"""
from __future__ import annotations

import time as _time
from dataclasses import dataclass, field, replace
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
from scipy.optimize import minimize_scalar

from ..data.catalog import OrbitalObject
from .propagation import MODEL_NUMERICAL, PropagationResult, propagate, propagate_batch
from .time_utils import iso, time_grid


@dataclass
class Conjunction:
    conjunction_id: str
    primary_id: str
    secondary_id: str
    tca_unix: float
    miss_distance_km: float
    relative_speed_kms: float
    relative_position_teme_km: np.ndarray  # secondary minus primary at TCA
    relative_velocity_teme_kms: np.ndarray
    primary_r_km: np.ndarray
    primary_v_kms: np.ndarray
    secondary_r_km: np.ndarray
    secondary_v_kms: np.ndarray
    primary_epoch_unix: Optional[float]
    secondary_epoch_unix: Optional[float]
    primary_model: str
    secondary_model: str
    coarse_step_s: float
    coarse_min_distance_km: float
    refinement: Dict[str, Any]
    quality: Dict[str, Any] = field(default_factory=lambda: {"warnings": [], "limitations": []})
    pc: Optional[Any] = None  # PcResult, attached by collision_probability
    threat_state: str = "MONITORING"
    threat_rationale: List[str] = field(default_factory=list)
    rank: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "conjunction_id": self.conjunction_id,
            "primary_id": self.primary_id,
            "secondary_id": self.secondary_id,
            "tca": iso(self.tca_unix),
            "tca_unix": self.tca_unix,
            "miss_distance_km": float(self.miss_distance_km),
            "relative_speed_kms": float(self.relative_speed_kms),
            "relative_position_teme_km": [float(x) for x in self.relative_position_teme_km],
            "relative_velocity_teme_kms": [float(x) for x in self.relative_velocity_teme_kms],
            "frame": "TEME",
            "units": {"position": "km", "velocity": "km/s"},
            "primary_state_teme": {"r_km": [float(x) for x in self.primary_r_km],
                                   "v_kms": [float(x) for x in self.primary_v_kms]},
            "secondary_state_teme": {"r_km": [float(x) for x in self.secondary_r_km],
                                     "v_kms": [float(x) for x in self.secondary_v_kms]},
            "primary_epoch": iso(self.primary_epoch_unix) if self.primary_epoch_unix else None,
            "secondary_epoch": iso(self.secondary_epoch_unix) if self.secondary_epoch_unix else None,
            "primary_model": self.primary_model,
            "secondary_model": self.secondary_model,
            "coarse_step_s": self.coarse_step_s,
            "coarse_min_distance_km": float(self.coarse_min_distance_km),
            "refinement": self.refinement,
            "quality": self.quality,
            "pc": self.pc.to_dict() if self.pc is not None else None,
            "threat_state": self.threat_state,
            "threat_rationale": list(self.threat_rationale),
            "rank": self.rank,
        }


@dataclass
class ScreeningResult:
    conjunctions: List[Conjunction]
    stats: Dict[str, Any]
    co_orbital: List[Dict[str, Any]] = field(default_factory=list)
    propagation_failures: List[Dict[str, Any]] = field(default_factory=list)
    coarse_minima: Dict[str, Tuple[float, float]] = field(default_factory=dict)  # object_id -> (min distance km, time)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "conjunctions": [c.to_dict() for c in self.conjunctions],
            "stats": self.stats,
            "co_orbital": self.co_orbital,
            "propagation_failures": self.propagation_failures,
        }


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def altitude_overlap_filter(primary: OrbitalObject, objects: Sequence[OrbitalObject],
                            margin_km: float) -> List[OrbitalObject]:
    """Keep objects whose perigee/apogee band (widened by margin) overlaps the
    primary's band. Objects with unknown bands are kept (conservative)."""
    if primary.perigee_alt_km is None or primary.apogee_alt_km is None:
        return [o for o in objects if o.object_id != primary.object_id]
    p_lo, p_hi = primary.perigee_alt_km, primary.apogee_alt_km
    kept = []
    for o in objects:
        if o.object_id == primary.object_id:
            continue
        if o.perigee_alt_km is None or o.apogee_alt_km is None:
            kept.append(o)
            continue
        if o.perigee_alt_km - margin_km <= p_hi and o.apogee_alt_km + margin_km >= p_lo:
            kept.append(o)
    return kept


def anchor(obj: OrbitalObject, t_unix: float, step_s: float = 10.0) -> OrbitalObject:
    """Return an object whose numerical state is re-anchored at t_unix so that
    repeated evaluations near t are cheap. SGP4 objects are returned unchanged."""
    if obj.propagation_model != MODEL_NUMERICAL:
        return obj
    res = propagate(obj, np.array([t_unix]), step_s)
    return replace(obj, state_epoch_unix=float(t_unix), r0_teme_km=res.positions_km[0].copy(),
                   v0_teme_kms=res.velocities_kms[0].copy())


def relative_state(primary: OrbitalObject, secondary: OrbitalObject, t_unix: float, step_s: float = 10.0):
    rp = propagate(primary, np.array([t_unix]), step_s)
    rs = propagate(secondary, np.array([t_unix]), step_s)
    if rp.status != "OK" or rs.status != "OK":
        raise ValueError("propagation failed during refinement")
    return (rp.positions_km[0], rp.velocities_kms[0], rs.positions_km[0], rs.velocities_kms[0])


def refine_tca(primary: OrbitalObject, secondary: OrbitalObject, t_lo: float, t_hi: float,
               tol_s: float = 1e-3, numerical_step_s: float = 10.0) -> Dict[str, Any]:
    """Minimise the inter-object distance inside [t_lo, t_hi] (bounded Brent)."""
    p = anchor(primary, t_lo, numerical_step_s)
    s = anchor(secondary, t_lo, numerical_step_s)
    evals = {"n": 0}

    # Minimise over the offset from t_lo: absolute unix times (~1e9 s) would make the
    # optimiser's relative tolerance tens of seconds wide.
    def dist(tau: float) -> float:
        evals["n"] += 1
        rp, _, rs, _ = relative_state(p, s, t_lo + tau, numerical_step_s)
        return float(np.linalg.norm(rs - rp))

    res = minimize_scalar(dist, bounds=(0.0, t_hi - t_lo), method="bounded",
                          options={"xatol": tol_s, "maxiter": 200})
    t_star = float(t_lo + res.x)
    rp, vp, rs, vs = relative_state(p, s, t_star, numerical_step_s)
    rel_r = rs - rp
    rel_v = vs - vp
    return {
        "tca_unix": t_star,
        "miss_distance_km": float(np.linalg.norm(rel_r)),
        "relative_speed_kms": float(np.linalg.norm(rel_v)),
        "rel_r": rel_r, "rel_v": rel_v, "rp": rp, "vp": vp, "rs": rs, "vs": vs,
        "refinement": {
            "method": "bounded Brent minimisation of |r_secondary(t) - r_primary(t)|",
            "bracket": [iso(t_lo), iso(t_hi)],
            "bracket_unix": [float(t_lo), float(t_hi)],
            "tolerance_s": tol_s,
            "function_evaluations": int(evals["n"]),
            "converged": bool(res.success),
        },
    }


def find_local_minima(d: np.ndarray) -> List[int]:
    """Indices of sample-level local minima of d (NaN-aware, interior only)."""
    n = len(d)
    out = []
    for i in range(1, n - 1):
        if np.isnan(d[i]) or np.isnan(d[i - 1]) or np.isnan(d[i + 1]):
            continue
        if d[i] < d[i - 1] and d[i] < d[i + 1]:
            out.append(i)
        elif d[i] < d[i - 1] and d[i] == d[i + 1]:
            # flat bottom: report the first sample of the plateau only
            j = i + 1
            while j < n - 1 and d[j] == d[i]:
                j += 1
            if d[i] < d[j]:
                out.append(i)
    return out


def conjunction_id_for(primary_id: str, secondary_id: str, tca_unix: float) -> str:
    def short(x: str) -> str:
        return x.replace("NORAD-", "")
    return f"CJ-{short(primary_id)}-{short(secondary_id)}-{int(round(tca_unix))}"


# --------------------------------------------------------------------------
# main entry point
# --------------------------------------------------------------------------

def screen(primary: OrbitalObject, objects: Sequence[OrbitalObject], t_start: float, t_end: float,
           screening_radius_km: float = 25.0, coarse_step_s: float = 30.0, altitude_margin_km: float = 50.0,
           co_orbital_min_speed_kms: float = 0.01, numerical_step_s: float = 10.0,
           apply_altitude_filter: bool = True) -> ScreeningResult:
    t_wall = _time.time()
    valid = [o for o in objects if o.validation_status != "INVALID" and o.object_id != primary.object_id]
    candidates = altitude_overlap_filter(primary, valid, altitude_margin_km) if apply_altitude_filter else list(valid)
    times = time_grid(t_start, t_end, coarse_step_s)
    results = propagate_batch([primary] + candidates, times, numerical_step_s)
    res_p = results[primary.object_id]
    failures: List[Dict[str, Any]] = []
    if res_p.status == "FAILED":
        raise ValueError(f"primary {primary.object_id} could not be propagated: {res_p.messages}")

    found: List[Conjunction] = []
    co_orbital: List[Dict[str, Any]] = []
    coarse_minima: Dict[str, Tuple[float, float]] = {}
    n_minima = 0
    for obj in candidates:
        res_s = results[obj.object_id]
        if res_s.status == "FAILED":
            failures.append({"object_id": obj.object_id, "messages": res_s.messages})
            continue
        if res_s.status == "PARTIAL":
            failures.append({"object_id": obj.object_id, "messages": res_s.messages, "partial": True})
        rel = res_s.positions_km - res_p.positions_km
        d = np.linalg.norm(rel, axis=1)
        i_coarse = int(np.nanargmin(d))
        coarse_minima[obj.object_id] = (float(d[i_coarse]), float(times[i_coarse]))
        if d[i_coarse] > screening_radius_km + 2.0 * coarse_step_s * 16.0:  # 16 km/s: max LEO relative speed
            continue
        rel_v = res_s.velocities_kms - res_p.velocities_kms
        speed = np.linalg.norm(rel_v, axis=1)
        if np.nanmax(speed) < co_orbital_min_speed_kms and np.nanmin(d) < screening_radius_km:
            # Flat series: identical or near-identical elements (docked vehicles share the station's TLE).
            co_orbital.append({"object_id": obj.object_id, "name": obj.name,
                               "min_distance_km": float(np.nanmin(d)), "relative_speed_kms": float(np.nanmax(speed)),
                               "at": iso(float(times[int(np.nanargmin(d))])),
                               "reason": "relative speed stays below the co-orbital threshold for the whole window; "
                                         "treated as a docked/co-located object, not a conjunction"})
            continue
        for i in find_local_minima(d):
            margin = 0.5 * coarse_step_s * float(speed[i])
            if d[i] > screening_radius_km + margin:
                continue
            n_minima += 1
            t_lo, t_hi = float(times[i - 1]), float(times[i + 1])
            try:
                ref = refine_tca(primary, obj, t_lo, t_hi, numerical_step_s=numerical_step_s)
            except ValueError as exc:
                failures.append({"object_id": obj.object_id, "messages": [str(exc)]})
                continue
            if ref["miss_distance_km"] >= screening_radius_km:
                continue
            if ref["relative_speed_kms"] < co_orbital_min_speed_kms:
                co_orbital.append({"object_id": obj.object_id, "name": obj.name,
                                   "min_distance_km": ref["miss_distance_km"],
                                   "relative_speed_kms": ref["relative_speed_kms"], "at": iso(ref["tca_unix"]),
                                   "reason": "relative speed below co-orbital threshold; treated as docked/formation "
                                             "object, not a conjunction"})
                continue
            quality = {"warnings": list(obj.warnings) + list(primary.warnings), "limitations": [
                f"coarse sampling step {coarse_step_s:.0f} s; minima narrower than the step adjacent to another "
                f"minimum may merge",
                "SGP4 positions are mean-element estimates whose error grows with time from the element epoch "
                "(typically km-level after a day)" if obj.propagation_model == "SGP4" or primary.propagation_model == "SGP4"
                else "synthetic states propagated with two-body + J2 only",
            ]}
            if obj.validation_status == "STALE":
                quality["warnings"].append("secondary elements flagged STALE")
            found.append(Conjunction(
                conjunction_id=conjunction_id_for(primary.object_id, obj.object_id, ref["tca_unix"]),
                primary_id=primary.object_id, secondary_id=obj.object_id,
                tca_unix=ref["tca_unix"], miss_distance_km=ref["miss_distance_km"],
                relative_speed_kms=ref["relative_speed_kms"],
                relative_position_teme_km=ref["rel_r"], relative_velocity_teme_kms=ref["rel_v"],
                primary_r_km=ref["rp"], primary_v_kms=ref["vp"], secondary_r_km=ref["rs"], secondary_v_kms=ref["vs"],
                primary_epoch_unix=primary.epoch_unix, secondary_epoch_unix=obj.epoch_unix,
                primary_model=primary.propagation_model, secondary_model=obj.propagation_model,
                coarse_step_s=coarse_step_s, coarse_min_distance_km=float(d[i]),
                refinement=ref["refinement"], quality=quality,
            ))

    found = dedupe(found, coarse_step_s)
    found.sort(key=lambda c: (c.miss_distance_km, c.tca_unix))
    for k, c in enumerate(found):
        c.rank = k + 1
    stats = {
        "window": {"start": iso(t_start), "end": iso(t_end)},
        "objects_total": len(objects),
        "objects_valid": len(valid),
        "candidates_after_altitude_filter": len(candidates),
        "altitude_filter_margin_km": altitude_margin_km if apply_altitude_filter else None,
        "coarse_step_s": coarse_step_s,
        "coarse_samples": int(len(times)),
        "screening_radius_km": screening_radius_km,
        "local_minima_refined": n_minima,
        "conjunctions_found": len(found),
        "co_orbital_rejected": len(co_orbital),
        "propagation_failures": len(failures),
        "duration_s": round(_time.time() - t_wall, 3),
        "complete": len(failures) == 0,
    }
    return ScreeningResult(found, stats, co_orbital, failures, coarse_minima)


def dedupe(conjunctions: List[Conjunction], coarse_step_s: float) -> List[Conjunction]:
    """Merge detections of the same pair whose TCAs lie within two coarse steps."""
    by_pair: Dict[Tuple[str, str], List[Conjunction]] = {}
    for c in conjunctions:
        by_pair.setdefault((c.primary_id, c.secondary_id), []).append(c)
    out: List[Conjunction] = []
    for items in by_pair.values():
        items.sort(key=lambda c: c.tca_unix)
        merged: List[Conjunction] = []
        for c in items:
            if merged and abs(c.tca_unix - merged[-1].tca_unix) <= 2.0 * coarse_step_s:
                if c.miss_distance_km < merged[-1].miss_distance_km:
                    merged[-1] = c
            else:
                merged.append(c)
        out.extend(merged)
    return out


def distance_series(primary: OrbitalObject, secondary: OrbitalObject, times: np.ndarray,
                    numerical_step_s: float = 10.0) -> Tuple[np.ndarray, PropagationResult, PropagationResult]:
    rp = propagate(primary, times, numerical_step_s)
    rs = propagate(secondary, times, numerical_step_s)
    return np.linalg.norm(rs.positions_km - rp.positions_km, axis=1), rp, rs
