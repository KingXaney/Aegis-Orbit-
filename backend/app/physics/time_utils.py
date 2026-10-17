"""Time helpers.

Internally every instant is a float "unix seconds" value (seconds since
1970-01-01T00:00:00Z, leap seconds ignored). The API exchanges ISO 8601 UTC
strings with a trailing Z. SGP4 needs Julian dates, derived here.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Tuple

import numpy as np

from .constants import JD_UNIX_EPOCH, SECONDS_PER_DAY


def to_unix(dt: datetime) -> float:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def from_unix(t: float) -> datetime:
    return datetime.fromtimestamp(float(t), tz=timezone.utc)


def iso(dt_or_unix) -> str:
    dt = dt_or_unix if isinstance(dt_or_unix, datetime) else from_unix(dt_or_unix)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    # round to the nearest millisecond (with carry into the seconds field)
    dt = dt + timedelta(microseconds=500)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def parse_iso(s: str) -> datetime:
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def unix_to_jd(t_unix) -> Tuple[np.ndarray, np.ndarray]:
    """Split unix seconds into (jd, fr) as expected by the sgp4 library."""
    t = np.asarray(t_unix, dtype=np.float64)
    days = t / SECONDS_PER_DAY
    jd_int = np.floor(days)
    jd = JD_UNIX_EPOCH + jd_int
    fr = days - jd_int
    return jd, fr


def jd_to_unix(jd: float, fr: float = 0.0) -> float:
    return ((jd - JD_UNIX_EPOCH) + fr) * SECONDS_PER_DAY


def time_grid(start_unix: float, end_unix: float, step_s: float) -> np.ndarray:
    """Inclusive time grid from start to end; the end sample is always included."""
    if end_unix < start_unix:
        raise ValueError("end must be >= start")
    n = int(np.floor((end_unix - start_unix) / step_s + 1e-9))
    times = start_unix + step_s * np.arange(n + 1)
    if times[-1] < end_unix - 1e-6:
        times = np.append(times, end_unix)
    return times


def add_seconds(dt: datetime, seconds: float) -> datetime:
    return dt + timedelta(seconds=seconds)
