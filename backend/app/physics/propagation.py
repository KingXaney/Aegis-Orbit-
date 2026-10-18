"""Trajectory propagation.

Two models are used and never silently interchanged:

* **SGP4** for objects defined by TLE/GP mean elements (output frame TEME,
  km and km/s). This is the only model applied to catalog records.
* **Two-body + J2, RK4 fixed step** for synthetic states and for post-burn
  trajectories. The maneuver planner takes the SGP4 (or synthetic) state at the
  burn time as the initial condition for this model. SGP4 additionally models
  drag, J3/J4 and resonance terms, so the un-maneuvered trajectory in the two
  models drifts apart by up to a few km over several hours; the planner reports
  that model difference explicitly (see maneuver_planner.baseline).
* **Piecewise**: an object with committed burns keeps its native model up to the
  first burn and follows a two-body + J2 arc from each burn's post-burn state to
  the next burn (``OrbitalObject.segments``). Every reader dispatches through
  ``propagate``, so screening, planning and trajectories see the committed path.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any, Dict, Iterable, List, Optional, Tuple

import numpy as np
from sgp4.api import SatrecArray

from ..data.catalog import OrbitalObject, Segment
from ..data.tle import SGP4_ERROR_MESSAGES
from .constants import J2, MU_EARTH_KM3_S2, R_EARTH_KM
from .time_utils import unix_to_jd

UNITS = {"position": "km", "velocity": "km/s", "time": "unix seconds (UTC)"}
MODEL_SGP4 = "SGP4"
MODEL_NUMERICAL = "NUMERICAL_J2"
MODEL_PIECEWISE = "PIECEWISE_J2"


@dataclass
class PropagationResult:
    object_id: str
    times_unix: np.ndarray
    positions_km: np.ndarray  # (N, 3) TEME
    velocities_kms: np.ndarray  # (N, 3) TEME
    model: str
    source_epoch_unix: Optional[float]
    status: str = "OK"  # OK | PARTIAL | FAILED
    error_codes: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=int))
    messages: List[str] = field(default_factory=list)
    frame: str = "TEME"
    units: Dict[str, str] = field(default_factory=lambda: dict(UNITS))

    @property
    def ok_mask(self) -> np.ndarray:
        if self.error_codes.size == 0:
            return np.ones(len(self.times_unix), dtype=bool)
        return self.error_codes == 0

    def state_at_index(self, i: int):
        return self.positions_km[i], self.velocities_kms[i]


# --------------------------------------------------------------------------
# SGP4
# --------------------------------------------------------------------------

def propagate_sgp4(obj: OrbitalObject, times_unix: np.ndarray) -> PropagationResult:
    if obj.satrec is None:
        return PropagationResult(obj.object_id, np.asarray(times_unix, float), np.zeros((0, 3)), np.zeros((0, 3)),
                                 MODEL_SGP4, obj.epoch_unix, status="FAILED",
                                 messages=["object has no SGP4 record"])
    times = np.asarray(times_unix, dtype=np.float64)
    jd, fr = unix_to_jd(times)
    err, r, v = obj.satrec.sgp4_array(jd, fr)
    return _finish(obj, times, err, r, v, MODEL_SGP4)


def _finish(obj: OrbitalObject, times: np.ndarray, err: np.ndarray, r: np.ndarray, v: np.ndarray,
            model: str) -> PropagationResult:
    err = np.asarray(err, dtype=int)
    n_bad = int(np.count_nonzero(err))
    status = "OK" if n_bad == 0 else ("FAILED" if n_bad == len(times) else "PARTIAL")
    messages = []
    if n_bad:
        codes = sorted(set(int(c) for c in err[err != 0]))
        for c in codes:
            messages.append(f"SGP4 error {c} ({SGP4_ERROR_MESSAGES.get(c, 'unknown')}) on "
                            f"{int(np.count_nonzero(err == c))} of {len(times)} samples")
    r = np.asarray(r, dtype=np.float64)
    v = np.asarray(v, dtype=np.float64)
    r[err != 0] = np.nan
    v[err != 0] = np.nan
    return PropagationResult(obj.object_id, times, r, v, model, obj.epoch_unix, status, err, messages)


# --------------------------------------------------------------------------
# Two-body + J2 numerical model
# --------------------------------------------------------------------------

def acceleration(r: np.ndarray, include_j2: bool = True) -> np.ndarray:
    """Gravitational acceleration (km/s^2) for positions r of shape (N, 3)."""
    rn = np.linalg.norm(r, axis=1, keepdims=True)
    a = -MU_EARTH_KM3_S2 * r / rn ** 3
    if include_j2:
        z2 = (r[:, 2:3] / rn) ** 2
        k = 1.5 * J2 * MU_EARTH_KM3_S2 * R_EARTH_KM ** 2 / rn ** 5
        a = a + k * np.concatenate([
            r[:, 0:1] * (5.0 * z2 - 1.0),
            r[:, 1:2] * (5.0 * z2 - 1.0),
            r[:, 2:3] * (5.0 * z2 - 3.0),
        ], axis=1)
    return a


def _deriv(y: np.ndarray, include_j2: bool) -> np.ndarray:
    return np.concatenate([y[:, 3:6], acceleration(y[:, 0:3], include_j2)], axis=1)


def rk4_step(y: np.ndarray, h: float, include_j2: bool = True) -> np.ndarray:
    k1 = _deriv(y, include_j2)
    k2 = _deriv(y + 0.5 * h * k1, include_j2)
    k3 = _deriv(y + 0.5 * h * k2, include_j2)
    k4 = _deriv(y + h * k3, include_j2)
    return y + (h / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4)


def propagate_states(states0: np.ndarray, t0: float, times_unix: np.ndarray, step_s: float = 10.0,
                     include_j2: bool = True) -> np.ndarray:
    """Integrate N states (N, 6) from t0 to each requested time.

    Returns an array of shape (M, N, 6). Times may lie before or after t0; the
    integrator marches in fixed sub-steps of at most ``step_s`` and lands exactly
    on each requested time.
    """
    states0 = np.atleast_2d(np.asarray(states0, dtype=np.float64))
    times = np.asarray(times_unix, dtype=np.float64)
    out = np.empty((len(times), states0.shape[0], 6), dtype=np.float64)
    order = np.argsort(times)
    sorted_times = times[order]
    fwd = sorted_times >= t0
    # forward march
    y = states0.copy()
    t = float(t0)
    for k in np.nonzero(fwd)[0]:
        target = sorted_times[k]
        while target - t > 1e-9:
            h = min(step_s, target - t)
            y = rk4_step(y, h, include_j2)
            t += h
        out[order[k]] = y
    # backward march
    y = states0.copy()
    t = float(t0)
    for k in np.nonzero(~fwd)[0][::-1]:
        target = sorted_times[k]
        while t - target > 1e-9:
            h = min(step_s, t - target)
            y = rk4_step(y, -h, include_j2)
            t -= h
        out[order[k]] = y
    return out


def propagate_numerical(obj: OrbitalObject, times_unix: np.ndarray, step_s: float = 10.0) -> PropagationResult:
    if obj.r0_teme_km is None or obj.v0_teme_kms is None or obj.state_epoch_unix is None:
        return PropagationResult(obj.object_id, np.asarray(times_unix, float), np.zeros((0, 3)), np.zeros((0, 3)),
                                 MODEL_NUMERICAL, obj.state_epoch_unix, status="FAILED",
                                 messages=["object has no initial state"])
    times = np.asarray(times_unix, dtype=np.float64)
    y0 = np.concatenate([obj.r0_teme_km, obj.v0_teme_kms])[None, :]
    ys = propagate_states(y0, obj.state_epoch_unix, times, step_s=step_s)
    r = ys[:, 0, 0:3]
    v = ys[:, 0, 3:6]
    return PropagationResult(obj.object_id, times, r, v, MODEL_NUMERICAL, obj.state_epoch_unix, "OK",
                             np.zeros(len(times), dtype=int), [])


# --------------------------------------------------------------------------
# Piecewise model: the native arc up to the first committed burn, then one
# two-body + J2 arc per burn
# --------------------------------------------------------------------------

def original_of(obj: OrbitalObject) -> OrbitalObject:
    """The object without its committed burns: native model, basis and orbit summary."""
    if obj.propagation_model != MODEL_PIECEWISE:
        return obj
    summary = dict(obj.base_summary or {})
    return replace(obj, propagation_model=obj.base_model or MODEL_NUMERICAL,
                   position_basis=obj.base_position_basis or obj.position_basis,
                   base_model="", base_position_basis="", base_summary=None, segments=(),
                   warnings=list(obj.warnings), **summary)


def burn_times(obj: OrbitalObject) -> List[float]:
    return [float(s.t_start_unix) for s in obj.segments]


def latest_state(obj: OrbitalObject) -> Tuple[Optional[float], np.ndarray, np.ndarray]:
    """(epoch_unix, r_km, v_kms) of the last arc's anchor, or the native state (SGP4: at its epoch)."""
    if obj.segments:
        s = obj.segments[-1]
        return s.epoch_unix, s.r0_km, s.v0_kms
    if obj.r0_teme_km is not None and obj.v0_teme_kms is not None and obj.state_epoch_unix is not None:
        return obj.state_epoch_unix, obj.r0_teme_km, obj.v0_teme_kms
    t = obj.epoch_unix
    if t is None:
        return None, np.full(3, np.nan), np.full(3, np.nan)
    res = propagate_sgp4(obj, np.array([t]))
    if res.positions_km.shape[0] != 1:
        return t, np.full(3, np.nan), np.full(3, np.nan)
    return t, res.positions_km[0], res.velocities_kms[0]


def _arc_index(obj: OrbitalObject, t_unix: float) -> int:
    """0 for the native arc, k for segments[k - 1] (the arc that starts at or before t)."""
    return int(np.searchsorted(np.array([s.t_start_unix for s in obj.segments]), t_unix, side="right"))


def propagate_piecewise(obj: OrbitalObject, times_unix: np.ndarray, step_s: float = 10.0) -> PropagationResult:
    times = np.asarray(times_unix, dtype=np.float64)
    n = len(times)
    r = np.full((n, 3), np.nan)
    v = np.full((n, 3), np.nan)
    err = np.zeros(n, dtype=int)
    messages: List[str] = []
    idx = np.searchsorted(np.array([s.t_start_unix for s in obj.segments]), times, side="right")
    base_mask = idx == 0
    if base_mask.any():
        res = propagate(original_of(obj), times[base_mask], step_s)
        if res.positions_km.shape[0] == int(base_mask.sum()):
            r[base_mask] = res.positions_km
            v[base_mask] = res.velocities_kms
            if res.error_codes.size:
                err[base_mask] = res.error_codes
        else:
            err[base_mask] = 1
        messages += res.messages
    for k, seg in enumerate(obj.segments, start=1):
        mask = idx == k
        if not mask.any():
            continue
        ys = propagate_states(np.concatenate([seg.r0_km, seg.v0_kms])[None, :], seg.epoch_unix, times[mask], step_s)
        r[mask] = ys[:, 0, 0:3]
        v[mask] = ys[:, 0, 3:6]
    n_bad = int(np.count_nonzero(err))
    status = "OK" if n_bad == 0 else ("FAILED" if n_bad == n else "PARTIAL")
    return PropagationResult(obj.object_id, times, r, v, MODEL_PIECEWISE, obj.epoch_unix, status, err, messages)


def _anchored_at(obj: OrbitalObject, t_unix: float, r_km: np.ndarray, v_kms: np.ndarray) -> OrbitalObject:
    r = np.asarray(r_km, dtype=float).copy()
    v = np.asarray(v_kms, dtype=float).copy()
    if obj.propagation_model == MODEL_PIECEWISE:
        k = _arc_index(obj, t_unix)
        if k == 0:
            return replace(obj, state_epoch_unix=float(t_unix), r0_teme_km=r, v0_teme_kms=v, warnings=list(obj.warnings))
        seg = replace(obj.segments[k - 1], epoch_unix=float(t_unix), r0_km=r, v0_kms=v)
        return replace(obj, segments=obj.segments[:k - 1] + (seg,) + obj.segments[k:], warnings=list(obj.warnings))
    return replace(obj, state_epoch_unix=float(t_unix), r0_teme_km=r, v0_teme_kms=v, warnings=list(obj.warnings))


def _anchorable(obj: OrbitalObject, t_unix: float) -> bool:
    if obj.propagation_model == MODEL_NUMERICAL:
        return True
    if obj.propagation_model == MODEL_PIECEWISE:
        return _arc_index(obj, t_unix) > 0 or (obj.base_model or "") == MODEL_NUMERICAL
    return False


def anchored(obj: OrbitalObject, t_unix: float, step_s: float = 10.0) -> OrbitalObject:
    """The same trajectory with its numerical anchor moved to t_unix, so repeated evaluations near
    t are cheap. SGP4 arcs are returned unchanged; a piecewise object re-anchors the arc containing
    t and keeps every later burn arc."""
    if not _anchorable(obj, t_unix):
        return obj
    res = propagate(obj, np.array([t_unix]), step_s)
    return _anchored_at(obj, t_unix, res.positions_km[0], res.velocities_kms[0])


def anchored_with_state(obj: OrbitalObject, t_unix: float, r_km: np.ndarray, v_kms: np.ndarray) -> OrbitalObject:
    """Like anchored(), using a state already known to lie on the trajectory at t_unix (no integration)."""
    if not _anchorable(obj, t_unix):
        return obj
    return _anchored_at(obj, t_unix, r_km, v_kms)


# --------------------------------------------------------------------------
# Dispatch
# --------------------------------------------------------------------------

def propagate(obj: OrbitalObject, times_unix: np.ndarray, numerical_step_s: float = 10.0) -> PropagationResult:
    """Position/velocity of one object at the requested times (TEME, km, km/s)."""
    if obj.propagation_model == MODEL_SGP4:
        return propagate_sgp4(obj, times_unix)
    if obj.propagation_model == MODEL_NUMERICAL:
        return propagate_numerical(obj, times_unix, step_s=numerical_step_s)
    if obj.propagation_model == MODEL_PIECEWISE:
        return propagate_piecewise(obj, times_unix, step_s=numerical_step_s)
    return PropagationResult(obj.object_id, np.asarray(times_unix, float), np.zeros((0, 3)), np.zeros((0, 3)),
                             obj.propagation_model, obj.epoch_unix, status="FAILED",
                             messages=[f"unknown propagation model '{obj.propagation_model}'"])


def propagate_batch(objects: Iterable[OrbitalObject], times_unix: np.ndarray,
                    numerical_step_s: float = 10.0) -> Dict[str, PropagationResult]:
    """Propagate many objects at the same times. SGP4 records are evaluated together through
    SatrecArray; numerical objects sharing an integration epoch are marched together in one RK4
    batch; everything else (piecewise objects, incomplete records) goes one by one."""
    objects = list(objects)
    times = np.asarray(times_unix, dtype=np.float64)
    results: Dict[str, PropagationResult] = {}
    sgp4_objs = [o for o in objects if o.propagation_model == MODEL_SGP4 and o.satrec is not None]
    if sgp4_objs:
        jd, fr = unix_to_jd(times)
        arr = SatrecArray([o.satrec for o in sgp4_objs])
        err, r, v = arr.sgp4(jd, fr)
        for i, o in enumerate(sgp4_objs):
            results[o.object_id] = _finish(o, times, err[i], r[i], v[i], MODEL_SGP4)
    groups: Dict[float, List[OrbitalObject]] = {}
    for o in objects:
        if (o.object_id not in results and o.propagation_model == MODEL_NUMERICAL and o.r0_teme_km is not None
                and o.v0_teme_kms is not None and o.state_epoch_unix is not None):
            groups.setdefault(float(o.state_epoch_unix), []).append(o)
    for epoch, group in groups.items():
        states0 = np.stack([np.concatenate([o.r0_teme_km, o.v0_teme_kms]) for o in group])
        ys = propagate_states(states0, epoch, times, numerical_step_s)
        for i, o in enumerate(group):
            results[o.object_id] = PropagationResult(o.object_id, times, np.ascontiguousarray(ys[:, i, 0:3]),
                                                     np.ascontiguousarray(ys[:, i, 3:6]), MODEL_NUMERICAL,
                                                     o.state_epoch_unix, "OK", np.zeros(len(times), dtype=int), [])
    for o in objects:
        if o.object_id in results:
            continue
        results[o.object_id] = propagate(o, times, numerical_step_s)
    return results


def state_at(obj: OrbitalObject, t_unix: float, numerical_step_s: float = 10.0):
    """Convenience: (r, v) at a single time, or raises if propagation failed."""
    res = propagate(obj, np.array([t_unix]), numerical_step_s)
    if res.status != "OK":
        raise ValueError(f"propagation of {obj.object_id} failed at t={t_unix}: {res.messages}")
    return res.positions_km[0], res.velocities_kms[0]
