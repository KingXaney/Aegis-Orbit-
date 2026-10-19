"""GPM's upcoming close approaches against the explorer catalog, for the home page.

The home page shows what the simulator's screening pipeline (physics/screening.py) finds for the real
GPM Core Observatory over the next 24 hours, against every object the explorer serves. Screening the
whole catalog takes several seconds, so it runs on a background thread: a request that finds no result
starts one and is told to come back, and a result older than REFRESH_AFTER_S is still served while its
replacement is computed.

Public GP elements carry no covariance, so no collision probability is attached: the record is the time
of closest approach, the miss distance and the relative speed. Each pass also carries the simulator's own
verdict: its threat state (physics/threat.py), and whether it is critical, meaning it misses the
distance-based mitigation target the planner uses when Pc is unavailable, so the simulator would plan a
burn for it.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Dict, List, Optional

from ..config import get_settings
from ..data import explorer_catalog
from ..data.catalog import OrbitalObject
from ..data.tle import object_from_tle
from ..physics import screening
from ..physics.threat import evaluate_threat_state, meets_mitigation_target
from ..physics.time_utils import iso

log = logging.getLogger(__name__)

MODEL_NORAD_ID = 39574  # GPM-CORE, the spacecraft the simulator flies
WINDOW_S = 24 * 3600.0
REFRESH_AFTER_S = 30 * 60.0
RETRY_AFTER_ERROR_S = 5 * 60.0
NOTE = ("Times and miss distances are SGP4 predictions from public mean elements, screened with the "
        "simulator's pipeline. Public elements carry no covariance, so no collision probability is given.")

_lock = threading.Lock()
_state: Dict[str, Any] = {"result": None, "running": False, "error": None, "error_at": 0.0}


def _orbital_objects(catalog: Dict[str, Any]) -> List[OrbitalObject]:
    out = []
    for row in catalog["objects"]:
        obj, _ = object_from_tle(row["name"], row["tle1"], row["tle2"])
        if obj is not None:
            out.append(obj)
    return out


def compute(now_unix: Optional[float] = None) -> Dict[str, Any]:
    """Screen GPM against the explorer catalog from now to WINDOW_S ahead."""
    catalog = explorer_catalog.get_catalog()
    objects = _orbital_objects(catalog)
    primary = next((o for o in objects if o.norad_id == MODEL_NORAD_ID), None)
    if primary is None:
        raise LookupError(f"NORAD {MODEL_NORAD_ID} (GPM-CORE) is not in the explorer catalog")
    types = {row["norad_id"]: row["type"] for row in catalog["objects"]}
    by_id = {o.object_id: o for o in objects}

    settings = get_settings()
    t0 = time.time() if now_unix is None else now_unix
    res = screening.screen(primary, objects, t0, t0 + WINDOW_S,
                           screening_radius_km=settings.screening_radius_km,
                           coarse_step_s=settings.screening_coarse_step_s,
                           altitude_margin_km=settings.altitude_filter_margin_km,
                           co_orbital_min_speed_kms=settings.co_orbital_min_relative_speed_kms)
    approaches = []
    for c in sorted(res.conjunctions, key=lambda c: c.tca_unix):
        secondary = by_id[c.secondary_id]
        state, _ = evaluate_threat_state(c.miss_distance_km, None, settings)
        meets_target, _ = meets_mitigation_target(c.miss_distance_km, None, settings)
        approaches.append({
            "norad_id": secondary.norad_id,
            "name": secondary.name,
            "type": types.get(secondary.norad_id, "DEBRIS"),
            "tca": iso(c.tca_unix),
            "tca_unix": c.tca_unix,
            "miss_distance_km": round(c.miss_distance_km, 3),
            "relative_speed_kms": round(c.relative_speed_kms, 3),
            "threat_state": state,
            "critical": not meets_target,
            "primary_position_teme_km": [round(float(x), 3) for x in c.primary_r_km],
            "secondary_position_teme_km": [round(float(x), 3) for x in c.secondary_r_km],
        })
    return {
        "primary_norad_id": MODEL_NORAD_ID,
        "primary_name": primary.name,
        "window_start": iso(t0),
        "window_end": iso(t0 + WINDOW_S),
        "window_start_unix": t0,
        "computed_at": iso(time.time()),
        "compute_s": res.stats["duration_s"],
        "catalog_retrieved_at": catalog.get("retrieved_at"),
        "screened": res.stats["objects_valid"],
        "screening_radius_km": res.stats["screening_radius_km"],
        "critical_distance_km": settings.miss_distance_target_km,
        "approaches": approaches,
        "note": NOTE,
    }


def _run() -> None:
    try:
        result = compute()
        with _lock:
            _state["result"], _state["error"] = result, None
        log.info("explorer screening: %d approaches in %.1f s", len(result["approaches"]), result["compute_s"])
    except Exception as exc:  # reported to the client; the previous result, if any, is kept
        log.exception("explorer screening failed")
        with _lock:
            _state["error"], _state["error_at"] = str(exc), time.time()
    finally:
        with _lock:
            _state["running"] = False


def _start_if_needed(now: float) -> None:
    """Start a background screening when there is no result, or it is old or from an older catalog. Call under _lock."""
    if _needs_run(now):
        _state["running"] = True
        threading.Thread(target=_run, name="explorer-screening", daemon=True).start()


def warm() -> None:
    """Start the first screening at startup, so the home page rarely has to wait for it."""
    with _lock:
        _start_if_needed(time.time())


def _needs_run(now: float) -> bool:
    """True when there is no result, or it is old or from an older catalog, and nothing blocks a run. Call under _lock."""
    result = _state["result"]
    current = (result is not None
               and now - result["window_start_unix"] < REFRESH_AFTER_S
               and result["catalog_retrieved_at"] == explorer_catalog.get_catalog().get("retrieved_at"))
    backing_off = _state["error"] is not None and now - _state["error_at"] < RETRY_AFTER_ERROR_S
    return not current and not _state["running"] and not backing_off


def get_approaches() -> Dict[str, Any]:
    """{'status': 'ready', 'result': …} (possibly while a refresh runs), or 'computing' / 'error' with no result yet.

    In synchronous mode (serverless: a background thread would be frozen or killed with the instance)
    the screening runs inside this request instead, so the first call on a cold instance is slow and
    later calls are instant."""
    if get_settings().explorer_sync_screening:
        with _lock:
            run_now = _needs_run(time.time())
            if run_now:
                _state["running"] = True
        if run_now:
            _run()
    with _lock:
        if not get_settings().explorer_sync_screening:
            _start_if_needed(time.time())
        if _state["result"] is not None:
            return {"status": "ready", "result": _state["result"]}
        if _state["error"] is not None and not _state["running"]:
            return {"status": "error", "error": _state["error"]}
        return {"status": "computing"}


def reset() -> None:
    with _lock:
        _state.update(result=None, error=None, error_at=0.0)
