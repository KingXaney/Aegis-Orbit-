"""Whole-catalog data for the explorer home page.

CelesTrak has no single "everything on orbit" GP query, so the catalog is the
union of three queries: active payloads (GROUP=active), every object named as
debris (NAME=DEB) and every rocket body (NAME=R/B). SATCAT is joined on NORAD
ID for the catalogued object type, the owner/operator and the launch date.

The joined rows are stored as gzipped JSON: the committed fixture keeps the
page usable offline, and a refresh writes the same format into the cache.
Positions are not computed here; the browser propagates the TLEs with SGP4.
"""
from __future__ import annotations

import gzip
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

from ..config import REPO_ROOT, get_settings
from ..physics.constants import R_EARTH_KM
from . import celestrak
from .satcat import SatcatRecord, parse_satcat_csv
from .tle import infer_category, object_from_tle, parse_tle_text

GP_QUERIES: Dict[str, Dict[str, str]] = {
    "active": {"GROUP": "active"},
    "debris": {"NAME": "DEB"},
    "rocket-bodies": {"NAME": "R/B"},
}
FIXTURE_PATH = REPO_ROOT / "data" / "catalog" / "explorer_catalog.json.gz"
CACHE_NAME = "explorer_catalog.json.gz"
# CelesTrak asks clients not to re-download unchanged GP data more often than this.
MIN_REFRESH_INTERVAL_S = 2 * 3600.0
SOURCE = "CelesTrak GP data and SATCAT (https://celestrak.org)"


def classify_orbit(perigee_km: float, apogee_km: float, period_s: float) -> str:
    """LEO / MEO / GEO / HEO from the mean elements' derived perigee, apogee and period."""
    rp, ra = perigee_km + R_EARTH_KM, apogee_km + R_EARTH_KM
    ecc = (ra - rp) / (ra + rp)
    period_min = period_s / 60.0
    if 1400.0 <= period_min <= 1460.0 and ecc < 0.1:
        return "GEO"
    if ecc >= 0.25 and apogee_km > 2000.0:
        return "HEO"
    if apogee_km < 2000.0:
        return "LEO"
    return "MEO"


def join_rows(tle_texts: Dict[str, str], satcat: Dict[int, SatcatRecord]) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    """Deduplicate the GP queries by NORAD ID and attach SATCAT metadata. Decayed objects are dropped."""
    rows: Dict[int, Dict[str, Any]] = {}
    stats = {"parsed": 0, "rejected": 0, "decayed": 0, "without_satcat": 0}
    for key, text in tle_texts.items():
        objs, rejected = parse_tle_text(text, source_detail=key)
        stats["parsed"] += len(objs)
        stats["rejected"] += len(rejected)
        for o in objs:
            if o.norad_id in rows:
                continue
            rec = satcat.get(o.norad_id)
            if rec is not None and rec.decay_date:
                stats["decayed"] += 1
                continue
            if rec is None:
                stats["without_satcat"] += 1
            rows[o.norad_id] = {
                "name": o.name,
                "tle1": o.tle_line1,
                "tle2": o.tle_line2,
                "type": rec.category if rec else infer_category(o.name),
                "type_basis": "SATCAT" if rec else "INFERRED_FROM_NAME",
                "owner": rec.owner if rec else None,
                "launch_date": rec.launch_date if rec else None,
                "query": key,
            }
    return list(rows.values()), stats


def write_rows(path: Path, rows: List[Dict[str, Any]], meta: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as fh:
        json.dump({**meta, "objects": rows}, fh, separators=(",", ":"))


def read_rows(path: Path) -> Dict[str, Any]:
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def catalog_objects(rows: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], int]:
    """Validate each row's TLE and derive the fields the explorer filters and displays."""
    out: List[Dict[str, Any]] = []
    rejected = 0
    for r in rows:
        obj, _ = object_from_tle(r["name"], r["tle1"], r["tle2"])
        if obj is None or obj.perigee_alt_km is None or obj.perigee_alt_km < 80.0:
            rejected += 1
            continue
        category = r.get("type") or "UNKNOWN"
        out.append({
            "norad_id": obj.norad_id,
            "name": obj.name,
            # The explorer shows three types; objects SATCAT lists as unknown are fragments in practice.
            "type": "DEBRIS" if category == "UNKNOWN" else category,
            "owner": r.get("owner"),
            "launch_date": r.get("launch_date"),
            "intl_designator": obj.intl_designator,
            "orbit_class": classify_orbit(obj.perigee_alt_km, obj.apogee_alt_km, obj.period_s),
            "inclination_deg": round(obj.inclination_deg, 3),
            "period_min": round(obj.period_s / 60.0, 3),
            "perigee_km": round(obj.perigee_alt_km, 1),
            "apogee_km": round(obj.apogee_alt_km, 1),
            "epoch": obj.epoch.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "tle1": obj.tle_line1,
            "tle2": obj.tle_line2,
        })
    return out, rejected


_cache: Dict[str, Any] = {}


def _source_path() -> Tuple[Path, str]:
    cached = get_settings().cache_path / CACHE_NAME
    if cached.exists():
        return cached, "cache"
    if not FIXTURE_PATH.exists():
        raise FileNotFoundError(f"explorer catalog fixture missing: {FIXTURE_PATH}")
    return FIXTURE_PATH, "fixture"


def get_catalog() -> Dict[str, Any]:
    """The explorer catalog as a response dict, built once per process (or after a refresh)."""
    if "catalog" not in _cache:
        path, origin = _source_path()
        data = read_rows(path)
        objects, rejected = catalog_objects(data["objects"])
        counts: Dict[str, int] = {}
        for o in objects:
            counts[o["type"]] = counts.get(o["type"], 0) + 1
        _cache["catalog"] = {
            "source": data.get("source", SOURCE),
            "origin": origin,
            "retrieved_at": data.get("retrieved_at"),
            "note": ("Mean elements fitted by the data provider. Positions are SGP4 estimates computed in the "
                     "browser, not live telemetry."),
            "total": len(objects),
            "rejected": rejected,
            "counts_by_type": counts,
            "objects": objects,
        }
    return _cache["catalog"]


def get_catalog_json() -> bytes:
    if "json" not in _cache:
        _cache["json"] = json.dumps(get_catalog(), separators=(",", ":")).encode("utf-8")
    return _cache["json"]


def get_catalog_etag() -> str:
    """A weak validator for the serialised catalog (weak because the response may be gzipped in transit)."""
    if "etag" not in _cache:
        _cache["etag"] = f'W/"{hashlib.blake2b(get_catalog_json(), digest_size=12).hexdigest()}"'
    return _cache["etag"]


def download_rows(force: bool = False) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Download (or reuse cached, if younger than the refresh interval) GP queries and SATCAT, then join them."""
    texts: Dict[str, str] = {}
    for key, params in GP_QUERIES.items():
        age = celestrak.entry_age_s(key, "tle")
        entry = celestrak.read_entry(key, "tle")
        if entry is not None and age is not None and age < MIN_REFRESH_INTERVAL_S and not force:
            texts[key] = entry[0]
        else:
            texts[key] = celestrak.fetch_gp(params)
            celestrak.save_entry(key, "tle", celestrak.CELESTRAK_GP_URL + "?" +
                                 "&".join(f"{k}={v}" for k, v in params.items()), texts[key])
    age = celestrak.entry_age_s("satcat", "csv")
    entry = celestrak.read_entry("satcat", "csv")
    if entry is not None and age is not None and age < MIN_REFRESH_INTERVAL_S and not force:
        satcat_text = entry[0]
    else:
        satcat_text = celestrak.fetch_satcat()
        celestrak.save_entry("satcat", "csv", celestrak.CELESTRAK_SATCAT_URL, satcat_text)
    rows, stats = join_rows(texts, parse_satcat_csv(satcat_text))
    meta = {"source": SOURCE, "queries": GP_QUERIES, "stats": stats,
            "retrieved_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    return rows, meta


def refresh_catalog() -> Dict[str, Any]:
    """Rebuild the cached catalog from CelesTrak. Raises celestrak.DataUnavailable when offline."""
    path = get_settings().cache_path / CACHE_NAME
    if path.exists():
        existing = read_rows(path)
        retrieved = existing.get("retrieved_at")
        if retrieved:
            age = (datetime.now(timezone.utc) - datetime.strptime(retrieved, "%Y-%m-%dT%H:%M:%SZ")
                   .replace(tzinfo=timezone.utc)).total_seconds()
            if age < MIN_REFRESH_INTERVAL_S:
                return {"status": "unchanged", "retrieved_at": retrieved,
                        "detail": "catalog is under 2 hours old; CelesTrak data would not have changed"}
    rows, meta = download_rows()
    write_rows(path, rows, meta)
    _cache.clear()
    return {"status": "ok", "retrieved_at": meta["retrieved_at"], "detail": f"rebuilt catalog with {len(rows)} objects"}


def reset_cache() -> None:
    _cache.clear()

