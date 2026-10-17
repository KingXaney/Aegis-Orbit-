"""Threat-state rules.

States are assigned purely from computed quantities and configured thresholds;
the language model never sets them.

    NORMAL      no conjunction inside the screening radius
    MONITORING  conjunction detected; risk below the elevated threshold, or
                unverifiable but farther than the unverified-distance limit
    ELEVATED    Pc >= pc_elevated_threshold
    CRITICAL    Pc >= pc_critical_threshold
    MITIGATED   an approved maneuver brings the encounter below the configured
                mitigation target and secondary screening raises nothing worse
                than MONITORING
    UNVERIFIED  close approach inside unverified_distance_km but no covariance,
                so Pc cannot be defended
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from ..config import Settings, get_settings

ORDER = ["NORMAL", "MONITORING", "UNVERIFIED", "ELEVATED", "CRITICAL"]


def evaluate_threat_state(miss_distance_km: float, pc: Optional[Any],
                          settings: Optional[Settings] = None) -> Tuple[str, List[str]]:
    s = settings or get_settings()
    rationale: List[str] = []
    if pc is not None and pc.status == "COMPUTED" and pc.value is not None:
        label = "illustrative" if pc.covariance_basis != "PROVIDED" else "provided-covariance"
        if pc.value >= s.pc_critical_threshold:
            rationale.append(f"Pc {pc.value:.2e} ({label}) >= critical threshold {s.pc_critical_threshold:.0e}")
            return "CRITICAL", rationale
        if pc.value >= s.pc_elevated_threshold:
            rationale.append(f"Pc {pc.value:.2e} ({label}) >= elevated threshold {s.pc_elevated_threshold:.0e}")
            return "ELEVATED", rationale
        rationale.append(f"Pc {pc.value:.2e} ({label}) below elevated threshold {s.pc_elevated_threshold:.0e}")
        return "MONITORING", rationale
    if miss_distance_km < s.unverified_distance_km:
        rationale.append(f"miss distance {miss_distance_km:.2f} km < {s.unverified_distance_km:g} km but no "
                         f"covariance is available, so the risk cannot be quantified")
        return "UNVERIFIED", rationale
    rationale.append(f"miss distance {miss_distance_km:.2f} km >= {s.unverified_distance_km:g} km; no covariance, "
                     f"monitoring only")
    return "MONITORING", rationale


def meets_mitigation_target(miss_distance_km: float, pc: Optional[Any],
                            settings: Optional[Settings] = None) -> Tuple[bool, str]:
    """Whether a (post-maneuver) encounter satisfies the configured demo target."""
    s = settings or get_settings()
    if pc is not None and pc.status == "COMPUTED" and pc.value is not None:
        ok = pc.value <= s.pc_mitigation_target
        return ok, (f"Pc {pc.value:.2e} {'<=' if ok else '>'} target {s.pc_mitigation_target:.0e} "
                    f"(covariance basis: {pc.covariance_basis})")
    ok = miss_distance_km >= s.miss_distance_target_km
    return ok, (f"no covariance: distance-based target, miss {miss_distance_km:.2f} km "
                f"{'>=' if ok else '<'} {s.miss_distance_target_km:g} km")


def worst_state(states: List[str]) -> str:
    if not states:
        return "NORMAL"
    return max(states, key=lambda st: ORDER.index(st) if st in ORDER else -1)


def thresholds_summary(settings: Optional[Settings] = None) -> Dict[str, Any]:
    s = settings or get_settings()
    return {
        "screening_radius_km": s.screening_radius_km,
        "unverified_distance_km": s.unverified_distance_km,
        "pc_elevated_threshold": s.pc_elevated_threshold,
        "pc_critical_threshold": s.pc_critical_threshold,
        "pc_mitigation_target": s.pc_mitigation_target,
        "miss_distance_target_km": s.miss_distance_target_km,
        "note": "Demonstration thresholds configured for this simulator; not universal safety standards.",
    }
