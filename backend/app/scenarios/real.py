"""Real-data scenario: ISS and the cached CelesTrak catalog.

The committed fixtures make the scenario usable offline: the full catalog
(data/scenarios/real_catalog_full.tle.gz, every object in the five groups) when
present, else the 400-object altitude-band subset (real_catalog.tle + .meta.json).
``refresh`` rebuilds the catalog from freshly
downloaded CelesTrak groups when network access is allowed. No conjunction is
fabricated: the scenario shows whatever the screening finds, and the UI
offers the synthetic scenario when nothing noteworthy is present.
"""
from __future__ import annotations

import gzip
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..config import BACKEND_ROOT, get_settings
from ..data import celestrak
from ..data.catalog import Catalog
from ..data.tle import flag_stale, parse_tle_text
from ..physics.time_utils import iso, parse_iso

SCENARIO_ID = "real-iss"
PRIMARY_ID = "NORAD-25544"
FIXTURE_TLE = BACKEND_ROOT / "data" / "scenarios" / "real_catalog.tle"
FIXTURE_META = BACKEND_ROOT / "data" / "scenarios" / "real_catalog.meta.json"
# The same download, every object kept (scripts/build_real_fixture.py --full): what the ML funnel filters.
FULL_FIXTURE_TLE = BACKEND_ROOT / "data" / "scenarios" / "real_catalog_full.tle.gz"
FULL_FIXTURE_META = BACKEND_ROOT / "data" / "scenarios" / "real_catalog_full.meta.json"
WINDOW_HOURS = 24.0
REFRESH_GROUPS = ["stations", "active", "cosmos-2251-debris", "iridium-33-debris", "fengyun-1c-debris"]
MAX_OBJECTS = 400
ALTITUDE_MARGIN_KM = 60.0

# Hard-body radius override for the ISS (approximate envelope radius, metres).
RADIUS_OVERRIDES_M = {PRIMARY_ID: 55.0}


def _apply_overrides(cat: Catalog) -> None:
    for oid, radius in RADIUS_OVERRIDES_M.items():
        obj = cat.get(oid)
        if obj is not None:
            obj.radius_m = radius
            obj.radius_basis = "SCENARIO_DEFINITION"


def load_fixture_catalog() -> Catalog:
    if not FIXTURE_TLE.exists():
        raise FileNotFoundError(f"real-data fixture missing: {FIXTURE_TLE}")
    meta = json.loads(FIXTURE_META.read_text()) if FIXTURE_META.exists() else {}
    retrieved_at = parse_iso(meta["retrieved_at"]) if meta.get("retrieved_at") else None
    objs, rejected = parse_tle_text(FIXTURE_TLE.read_text(), source="celestrak",
                                    source_detail="cached fixture (" + ", ".join(meta.get("groups", [])) + ")",
                                    retrieved_at=retrieved_at)
    cat = Catalog(objs, rejected, {"kind": "real", "scenario_id": SCENARIO_ID, "fixture": str(FIXTURE_TLE.name),
                                   "retrieved_at": meta.get("retrieved_at"), "groups": meta.get("groups"),
                                   "filter": meta.get("filter"), "note": meta.get("note"), "live_refresh": False})
    _apply_overrides(cat)
    return cat


def load_full_catalog() -> Optional[Catalog]:
    """Every tracked object in the cached groups (the catalog the perception model filters), from the
    gzipped full fixture; None when that fixture is not present."""
    if not FULL_FIXTURE_TLE.exists():
        return None
    meta = json.loads(FULL_FIXTURE_META.read_text()) if FULL_FIXTURE_META.exists() else {}
    retrieved_at = parse_iso(meta["retrieved_at"]) if meta.get("retrieved_at") else None
    text = gzip.decompress(FULL_FIXTURE_TLE.read_bytes()).decode("utf-8")
    objs, rejected = parse_tle_text(text, source="celestrak",
                                    source_detail="cached full catalog (" + ", ".join(meta.get("groups", [])) + ")",
                                    retrieved_at=retrieved_at)
    cat = Catalog(objs, rejected, {"kind": "real", "scenario_id": SCENARIO_ID, "fixture": FULL_FIXTURE_TLE.name,
                                   "retrieved_at": meta.get("retrieved_at"), "groups": meta.get("groups"),
                                   "filter": meta.get("filter"), "note": meta.get("note"), "live_refresh": False,
                                   "full_catalog": True})
    _apply_overrides(cat)
    return cat


def build_live_catalog(primary_norad: int = 25544) -> Catalog:
    """Download the CelesTrak groups and apply the same selection as the fixture builder."""
    by_norad = {}
    rejected: List[Dict[str, Any]] = []
    metas = []
    for g in REFRESH_GROUPS:
        text, meta = celestrak.load_group(g, refresh=True)
        metas.append(meta)
        retrieved = parse_iso(meta["retrieved_at"])
        objs, rej = parse_tle_text(text, source="celestrak", source_detail=f"GROUP={g}", retrieved_at=retrieved)
        rejected.extend(rej)
        for o in objs:
            by_norad.setdefault(o.norad_id, o)
    primary = by_norad.get(primary_norad)
    if primary is None:
        raise celestrak.DataUnavailable(f"primary NORAD {primary_norad} not present in downloaded groups")
    p_lo, p_hi = primary.perigee_alt_km, primary.apogee_alt_km
    selected = []
    for norad, o in by_norad.items():
        if norad == primary_norad or o.name.startswith("ISS (") or o.name.strip() == "POISK":
            continue
        if o.perigee_alt_km - ALTITUDE_MARGIN_KM <= p_hi and o.apogee_alt_km + ALTITUDE_MARGIN_KM >= p_lo:
            center = 0.5 * (o.perigee_alt_km + o.apogee_alt_km)
            selected.append((abs(center - 0.5 * (p_lo + p_hi)), o))
    selected.sort(key=lambda t: (t[0], t[1].norad_id))
    objs = [primary] + [o for _, o in selected[: MAX_OBJECTS - 1]]
    cat = Catalog(objs, rejected, {"kind": "real", "scenario_id": SCENARIO_ID, "live_refresh": True,
                                   "retrieved_at": metas[0]["retrieved_at"], "groups": REFRESH_GROUPS,
                                   "filter": {"margin_km": ALTITUDE_MARGIN_KM, "max_objects": MAX_OBJECTS,
                                              "candidates_matching": len(selected)}})
    _apply_overrides(cat)
    return cat


def scenario_window(cat: Catalog) -> Dict[str, float]:
    """Window anchored at the primary's element epoch (rounded down to the hour)
    so that SGP4 is evaluated close to its epoch."""
    primary = cat.require(PRIMARY_ID)
    start = int(primary.epoch_unix // 3600) * 3600.0
    return {"start_unix": float(start), "end_unix": float(start + WINDOW_HOURS * 3600.0)}


def flag_stale_records(cat: Catalog, reference_unix: float) -> None:
    flag_stale(cat.values(), reference_unix, get_settings().stale_elements_days)
