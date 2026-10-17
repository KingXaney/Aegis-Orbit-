"""TLE / GP record parsing and validation.

Public GP data (CelesTrak) are *mean elements* fitted by the data provider;
positions obtained from them are SGP4 estimates, not sensor telemetry. Every
parsed object keeps its element epoch, data source and retrieval timestamp.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from sgp4.api import Satrec

from ..physics.constants import MU_EARTH_KM3_S2, R_EARTH_KM
from ..physics.time_utils import jd_to_unix
from .catalog import CATEGORY_DEFAULT_RADIUS_M, OrbitalObject

SGP4_ERROR_MESSAGES = {
    1: "mean elements out of range (eccentricity or mean motion)",
    2: "mean motion is negative",
    3: "perturbed elements out of range",
    4: "semi-latus rectum is negative",
    5: "epoch elements are sub-orbital",
    6: "satellite has decayed",
}


def tle_checksum(line: str) -> int:
    total = 0
    for ch in line[:68]:
        if ch.isdigit():
            total += int(ch)
        elif ch == "-":
            total += 1
    return total % 10


def validate_tle_lines(line1: str, line2: str) -> List[str]:
    """Return a list of problems (empty when the pair is structurally valid)."""
    problems: List[str] = []
    for idx, line in ((1, line1), (2, line2)):
        if len(line) < 69:
            problems.append(f"line {idx} is shorter than 69 characters")
            continue
        if line[0] != str(idx):
            problems.append(f"line {idx} does not start with '{idx}'")
        if not line[68].isdigit() or int(line[68]) != tle_checksum(line):
            problems.append(f"line {idx} checksum mismatch")
    if not problems and line1[2:7] != line2[2:7]:
        problems.append("catalog number differs between line 1 and line 2")
    return problems


def infer_category(name: str) -> str:
    upper = name.upper()
    if " DEB" in upper or upper.endswith("DEB") or "DEBRIS" in upper:
        return "DEBRIS"
    if "R/B" in upper or "ROCKET" in upper:
        return "ROCKET_BODY"
    return "PAYLOAD"


def _epoch_from_satrec(sat: Satrec) -> datetime:
    unix = jd_to_unix(sat.jdsatepoch, sat.jdsatepochF)
    return datetime.fromtimestamp(unix, tz=timezone.utc)


def object_from_tle(name: str, line1: str, line2: str, source: str = "celestrak", source_detail: str = "",
                    retrieved_at: Optional[datetime] = None) -> Tuple[Optional[OrbitalObject], Optional[Dict[str, Any]]]:
    """Build an OrbitalObject from a TLE. Returns (object, None) or (None, rejection record)."""
    name = (name or "").strip() or f"OBJECT {line1[2:7].strip()}"
    problems = validate_tle_lines(line1, line2)
    if problems:
        return None, {"name": name, "line1": line1, "line2": line2, "reason": "; ".join(problems)}
    try:
        sat = Satrec.twoline2rv(line1, line2)
    except Exception as exc:  # pragma: no cover - defensive
        return None, {"name": name, "line1": line1, "reason": f"sgp4 could not parse record: {exc}"}

    epoch = _epoch_from_satrec(sat)
    # Evaluate at epoch to catch records SGP4 cannot propagate at all.
    err, _, _ = sat.sgp4(sat.jdsatepoch, sat.jdsatepochF)
    if err != 0:
        return None, {"name": name, "norad_id": sat.satnum, "line1": line1,
                      "reason": f"SGP4 error {err}: {SGP4_ERROR_MESSAGES.get(err, 'unknown')}"}

    n_rad_s = sat.no_kozai / 60.0
    a_km = (MU_EARTH_KM3_S2 / (n_rad_s ** 2)) ** (1.0 / 3.0)
    e = float(sat.ecco)
    category = infer_category(name)
    obj = OrbitalObject(
        object_id=f"NORAD-{sat.satnum}",
        name=name,
        category=category,
        category_basis="INFERRED_FROM_NAME",
        source=source,
        source_detail=source_detail,
        epoch=epoch,
        retrieved_at=retrieved_at,
        propagation_model="SGP4",
        position_basis="PROPAGATED_FROM_GP_ELEMENTS",
        norad_id=int(sat.satnum),
        intl_designator=line1[9:17].strip() or None,
        tle_line1=line1,
        tle_line2=line2,
        satrec=sat,
        radius_m=CATEGORY_DEFAULT_RADIUS_M.get(category, 2.0),
        radius_basis="ASSUMED_DEFAULT",
        perigee_alt_km=float(a_km * (1.0 - e) - R_EARTH_KM),
        apogee_alt_km=float(a_km * (1.0 + e) - R_EARTH_KM),
        period_s=float(2.0 * np.pi / n_rad_s),
        inclination_deg=float(np.degrees(sat.inclo)),
    )
    if obj.perigee_alt_km is not None and obj.perigee_alt_km < 80.0:
        obj.warnings.append("perigee below 80 km: record is near re-entry, propagation unreliable")
    return obj, None


def parse_tle_text(text: str, source: str = "celestrak", source_detail: str = "",
                   retrieved_at: Optional[datetime] = None) -> Tuple[List[OrbitalObject], List[Dict[str, Any]]]:
    """Parse 2-line or 3-line element sets. Malformed records are returned separately."""
    lines = [ln.rstrip("\r\n") for ln in text.splitlines() if ln.strip()]
    objects: List[OrbitalObject] = []
    rejected: List[Dict[str, Any]] = []
    i = 0
    pending_name: Optional[str] = None
    while i < len(lines):
        line = lines[i]
        if line.startswith("1 ") and i + 1 < len(lines) and lines[i + 1].startswith("2 "):
            obj, rej = object_from_tle(pending_name or "", line, lines[i + 1], source, source_detail, retrieved_at)
            if obj is not None:
                objects.append(obj)
            else:
                rejected.append(rej)
            pending_name = None
            i += 2
            continue
        if line.startswith("1 ") or line.startswith("2 "):
            rejected.append({"name": pending_name, "line1": line, "reason": "unpaired element line"})
            pending_name = None
            i += 1
            continue
        pending_name = line.strip()
        i += 1
    return objects, rejected


def flag_stale(objects: List[OrbitalObject], reference_unix: float, max_age_days: float) -> None:
    """Mark records whose epoch is older than max_age_days before the reference time."""
    for obj in objects:
        if obj.epoch is None:
            continue
        age_days = (reference_unix - obj.epoch.timestamp()) / 86400.0
        if age_days > max_age_days:
            obj.validation_status = "STALE" if obj.validation_status == "OK" else obj.validation_status
            obj.warnings.append(f"elements are {age_days:.1f} days old relative to the scenario window; "
                                f"SGP4 accuracy degrades with age")
