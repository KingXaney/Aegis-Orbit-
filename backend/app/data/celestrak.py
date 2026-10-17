"""CelesTrak GP data download and local cache.

Downloaded files are stored under the configured cache directory together with
a sidecar JSON holding the retrieval timestamp and the URL, so every object can
report where and when its elements were obtained.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

from ..config import get_settings

CELESTRAK_GP_URL = "https://celestrak.org/NORAD/elements/gp.php"
# CelesTrak rejects some default library user agents with 403; identify the client honestly.
USER_AGENT = "aegis-orbit-simulator/0.1 (+https://github.com/KingXaney/Aegis-Orbit-; research prototype)"
CELESTRAK_SATCAT_URL = "https://celestrak.org/pub/satcat.csv"


class DataUnavailable(RuntimeError):
    pass


def _cache_files(group: str) -> Tuple[Path, Path]:
    base = get_settings().cache_path
    return base / f"celestrak_{group}.tle", base / f"celestrak_{group}.meta.json"


def _download(url: str, params: Optional[Dict[str, str]], what: str, timeout_s: float) -> str:
    settings = get_settings()
    if not settings.allow_network:
        raise DataUnavailable("network access is disabled (ALLOW_NETWORK=false)")
    try:
        resp = httpx.get(url, params=params, timeout=timeout_s, follow_redirects=True,
                         headers={"User-Agent": USER_AGENT, "Accept": "text/plain,text/csv,*/*"})
        if resp.status_code == 403 and "has not updated" in resp.text:
            # CelesTrak refuses repeat downloads of the same query within its 2-hour update cycle.
            raise DataUnavailable(f"CelesTrak throttled {what}: {' '.join(resp.text.split())}")
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise DataUnavailable(f"could not download CelesTrak {what}: {exc}") from exc
    return resp.text


def fetch_gp(params: Dict[str, str], timeout_s: float = 60.0) -> str:
    """Download GP element sets in TLE format for a gp.php query (GROUP=…, NAME=…)."""
    what = "query " + "&".join(f"{k}={v}" for k, v in params.items())
    text = _download(CELESTRAK_GP_URL, {**params, "FORMAT": "tle"}, what, timeout_s)
    if "1 " not in text:
        raise DataUnavailable(f"CelesTrak response for {what} contained no element sets")
    return text


def fetch_group_tle(group: str, timeout_s: float = 60.0) -> str:
    return fetch_gp({"GROUP": group}, timeout_s)


def fetch_satcat(timeout_s: float = 120.0) -> str:
    text = _download(CELESTRAK_SATCAT_URL, None, "SATCAT", timeout_s)
    if not text.startswith("OBJECT_NAME"):
        raise DataUnavailable("CelesTrak SATCAT response is not the expected CSV")
    return text


def save_group(group: str, text: str, retrieved_at: Optional[datetime] = None) -> Dict[str, Any]:
    tle_path, meta_path = _cache_files(group)
    retrieved_at = retrieved_at or datetime.now(timezone.utc)
    tle_path.write_text(text, encoding="utf-8")
    meta = {
        "group": group,
        "url": f"{CELESTRAK_GP_URL}?GROUP={group}&FORMAT=tle",
        "retrieved_at": retrieved_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "line_count": len([ln for ln in text.splitlines() if ln.strip()]),
    }
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def load_group(group: str, refresh: bool = False) -> Tuple[str, Dict[str, Any]]:
    """Return (tle_text, meta) for a CelesTrak group, downloading when needed."""
    tle_path, meta_path = _cache_files(group)
    if not refresh and tle_path.exists() and meta_path.exists():
        return tle_path.read_text(encoding="utf-8"), json.loads(meta_path.read_text(encoding="utf-8"))
    text = fetch_group_tle(group)
    meta = save_group(group, text)
    return text, meta


def refresh_groups(groups: List[str]) -> List[Dict[str, Any]]:
    return [load_group(g, refresh=True)[1] for g in groups]


def cached_groups() -> List[Dict[str, Any]]:
    base = get_settings().cache_path
    out = []
    for meta_path in sorted(base.glob("celestrak_*.meta.json")):
        try:
            out.append(json.loads(meta_path.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            continue
    return out


def _cache_entry(key: str, ext: str) -> Tuple[Path, Path]:
    base = get_settings().cache_path
    return base / f"explorer_{key}.{ext}", base / f"explorer_{key}.meta.json"


def save_entry(key: str, ext: str, url: str, text: str) -> Dict[str, Any]:
    data_path, meta_path = _cache_entry(key, ext)
    data_path.write_text(text, encoding="utf-8")
    meta = {"key": key, "url": url, "retrieved_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "line_count": len([ln for ln in text.splitlines() if ln.strip()])}
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def read_entry(key: str, ext: str) -> Optional[Tuple[str, Dict[str, Any]]]:
    data_path, meta_path = _cache_entry(key, ext)
    if not (data_path.exists() and meta_path.exists()):
        return None
    return data_path.read_text(encoding="utf-8"), json.loads(meta_path.read_text(encoding="utf-8"))


def entry_age_s(key: str, ext: str) -> Optional[float]:
    data_path, _ = _cache_entry(key, ext)
    return time.time() - data_path.stat().st_mtime if data_path.exists() else None
