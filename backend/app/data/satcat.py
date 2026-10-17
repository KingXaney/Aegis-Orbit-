"""CelesTrak SATCAT parsing.

SATCAT supplies what element sets do not: the object type as catalogued
(payload, rocket body, debris), the owner/operator code, the launch date and
the decay date.
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from typing import Dict, Optional

SATCAT_TYPES = {"PAY": "PAYLOAD", "R/B": "ROCKET_BODY", "DEB": "DEBRIS", "UNK": "UNKNOWN"}


@dataclass(frozen=True)
class SatcatRecord:
    norad_id: int
    name: str
    intl_designator: Optional[str]
    category: str  # PAYLOAD | ROCKET_BODY | DEBRIS | UNKNOWN
    owner: Optional[str]
    launch_date: Optional[str]
    decay_date: Optional[str]
    ops_status: Optional[str]


def parse_satcat_csv(text: str) -> Dict[int, SatcatRecord]:
    out: Dict[int, SatcatRecord] = {}
    for row in csv.DictReader(io.StringIO(text)):
        try:
            norad = int(row["NORAD_CAT_ID"])
        except (KeyError, TypeError, ValueError):
            continue
        out[norad] = SatcatRecord(
            norad_id=norad,
            name=(row.get("OBJECT_NAME") or "").strip(),
            intl_designator=(row.get("OBJECT_ID") or "").strip() or None,
            category=SATCAT_TYPES.get((row.get("OBJECT_TYPE") or "").strip(), "UNKNOWN"),
            owner=(row.get("OWNER") or "").strip() or None,
            launch_date=(row.get("LAUNCH_DATE") or "").strip() or None,
            decay_date=(row.get("DECAY_DATE") or "").strip() or None,
            ops_status=(row.get("OPS_STATUS_CODE") or "").strip() or None,
        )
    return out
