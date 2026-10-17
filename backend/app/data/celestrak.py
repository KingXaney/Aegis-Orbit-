"""CelesTrak GP data download and local cache.

Downloaded files are stored under the configured cache directory together with
a sidecar JSON holding the retrieval timestamp and the URL, so every object can
report where and when its elements were obtained.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

from ..config import get_settings

CELESTRAK_GP_URL = "https://celestrak.org/NORAD/elements/gp.php"


class DataUnavailable(RuntimeError):
    pass


def _cache_files(group: str) -> Tuple[Path, Path]:
    base = get_settings().cache_path
    return base / f"celestrak_{group}.tle", base / f"celestrak_{group}.meta.json"


def fetch_group_tle(group: str, timeout_s: float = 60.0) -> str:
    settings = get_settings()
    if not settings.allow_network:
        raise DataUnavailable("network access is disabled (ALLOW_NETWORK=false)")
    try:
        resp = httpx.get(CELESTRAK_GP_URL, params={"GROUP": group, "FORMAT": "tle"}, timeout=timeout_s,
                         follow_redirects=True)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise DataUnavailable(f"could not download CelesTrak group '{group}': {exc}") from exc
    text = resp.text
    if "1 " not in text:
        raise DataUnavailable(f"CelesTrak response for group '{group}' contained no element sets")
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
