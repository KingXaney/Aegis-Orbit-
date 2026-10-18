"""Coordinate frames and orbital-element helpers.

Canonical frame for every state in this project: **TEME** (True Equator, Mean
Equinox of date), the native output frame of SGP4, with positions in km and
velocities in km/s. The numerical two-body + J2 model is integrated in the same
frame treated as inertial (J2 is symmetric about the TEME z axis, which is the
Earth's spin axis, so this is the natural frame for it). The frontend converts
TEME to Cesium's Earth-fixed frame at render time via the GMST rotation.
"""
from __future__ import annotations

from typing import Dict

import numpy as np

from .constants import EARTH_ROTATION_RATE_RAD_S, MU_EARTH_KM3_S2, R_EARTH_KM, SECONDS_PER_DAY
from .time_utils import unix_to_jd


def rtn_basis(r: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Return a 3x3 matrix whose columns are the unit R, T, N vectors in the
    inertial frame (radial, along-track, cross-track) for state (r, v)."""
    r = np.asarray(r, dtype=float)
    v = np.asarray(v, dtype=float)
    R = r / np.linalg.norm(r)
    h = np.cross(r, v)
    N = h / np.linalg.norm(h)
    T = np.cross(N, R)
    return np.column_stack([R, T, N])


def rotate_about(vec: np.ndarray, axis: np.ndarray, angle_rad: float) -> np.ndarray:
    """Rodrigues rotation of ``vec`` about ``axis`` by ``angle_rad``."""
    vec = np.asarray(vec, dtype=float)
    axis = np.asarray(axis, dtype=float)
    axis = axis / np.linalg.norm(axis)
    c, s = np.cos(angle_rad), np.sin(angle_rad)
    return vec * c + np.cross(axis, vec) * s + axis * np.dot(axis, vec) * (1.0 - c)


def rtn_to_inertial(vec_rtn: np.ndarray, r: np.ndarray, v: np.ndarray) -> np.ndarray:
    return rtn_basis(r, v) @ np.asarray(vec_rtn, dtype=float)


def inertial_to_rtn(vec: np.ndarray, r: np.ndarray, v: np.ndarray) -> np.ndarray:
    return rtn_basis(r, v).T @ np.asarray(vec, dtype=float)


def relative_state_rtn(r_p: np.ndarray, v_p: np.ndarray, r_s: np.ndarray, v_s: np.ndarray):
    """Relative position and *co-moving* relative velocity of a secondary with
    respect to a primary, expressed in the primary's RTN frame (km, km/s).

    The RTN frame rotates with the primary at omega = (r x v)/|r|^2, so the
    velocity seen by an observer riding with the primary is
    (v_s - v_p) - omega x (r_s - r_p). The inertial velocity difference is what
    the screening reports as ``relative_velocity_teme``; this helper gives the
    rotating-frame value used for local (Waymo-style) views.
    """
    r_p = np.asarray(r_p, dtype=float)
    v_p = np.asarray(v_p, dtype=float)
    rel_r = np.asarray(r_s, dtype=float) - r_p
    omega = np.cross(r_p, v_p) / np.dot(r_p, r_p)
    v_rel = (np.asarray(v_s, dtype=float) - v_p) - np.cross(omega, rel_r)
    basis = rtn_basis(r_p, v_p)
    return basis.T @ rel_r, basis.T @ v_rel


def relative_positions_rtn(rp: np.ndarray, vp: np.ndarray, rs: np.ndarray) -> np.ndarray:
    """Batched (N,3) secondary-minus-primary positions in the primary's RTN frame."""
    rp = np.asarray(rp, dtype=float)
    vp = np.asarray(vp, dtype=float)
    rel = np.asarray(rs, dtype=float) - rp
    R = rp / np.linalg.norm(rp, axis=1, keepdims=True)
    h = np.cross(rp, vp)
    N = h / np.linalg.norm(h, axis=1, keepdims=True)
    T = np.cross(N, R)
    return np.stack([np.einsum("ij,ij->i", rel, R), np.einsum("ij,ij->i", rel, T), np.einsum("ij,ij->i", rel, N)], axis=1)


def covariance_rtn_to_inertial(cov_rtn: np.ndarray, r: np.ndarray, v: np.ndarray) -> np.ndarray:
    M = rtn_basis(r, v)
    return M @ np.asarray(cov_rtn, dtype=float) @ M.T


def gmst_rad(t_unix: float) -> float:
    """Greenwich Mean Sidereal Time (IAU 1982 polynomial), UT1 ~= UTC assumed."""
    jd, fr = unix_to_jd(t_unix)
    jd_ut1 = float(jd) + float(fr)
    t = (jd_ut1 - 2451545.0) / 36525.0
    gmst_s = (
        67310.54841
        + (876600.0 * 3600.0 + 8640184.812866) * t
        + 0.093104 * t * t
        - 6.2e-6 * t * t * t
    )
    gmst = (gmst_s % SECONDS_PER_DAY) / SECONDS_PER_DAY * 2.0 * np.pi
    return float(gmst)


def teme_to_ecef(r_teme: np.ndarray, t_unix: float) -> np.ndarray:
    """Rotate a TEME vector to the pseudo-Earth-fixed frame (GMST rotation only;
    polar motion neglected). Adequate for geographic read-outs."""
    th = gmst_rad(t_unix)
    c, s = np.cos(th), np.sin(th)
    rot = np.array([[c, s, 0.0], [-s, c, 0.0], [0.0, 0.0, 1.0]])
    return rot @ np.asarray(r_teme, dtype=float)


def ecef_to_geodetic(r_ecef: np.ndarray) -> Dict[str, float]:
    """WGS-84 geodetic latitude/longitude (deg) and altitude (km) from ECEF km."""
    a = R_EARTH_KM
    f = 1.0 / 298.257223563
    e2 = f * (2.0 - f)
    x, y, z = (float(c) for c in r_ecef)
    lon = np.arctan2(y, x)
    p = np.hypot(x, y)
    lat = np.arctan2(z, p * (1.0 - e2))
    for _ in range(6):
        sin_lat = np.sin(lat)
        n = a / np.sqrt(1.0 - e2 * sin_lat * sin_lat)
        alt = p / np.cos(lat) - n
        lat = np.arctan2(z, p * (1.0 - e2 * n / (n + alt)))
    sin_lat = np.sin(lat)
    n = a / np.sqrt(1.0 - e2 * sin_lat * sin_lat)
    alt = p / np.cos(lat) - n
    return {"lat_deg": float(np.degrees(lat)), "lon_deg": float(np.degrees(lon)), "alt_km": float(alt)}


def osculating_elements(r: np.ndarray, v: np.ndarray, mu: float = MU_EARTH_KM3_S2) -> Dict[str, float]:
    """Classical osculating elements from an inertial state (km, km/s)."""
    r = np.asarray(r, dtype=float)
    v = np.asarray(v, dtype=float)
    rn = np.linalg.norm(r)
    vn = np.linalg.norm(v)
    h = np.cross(r, v)
    hn = np.linalg.norm(h)
    energy = vn * vn / 2.0 - mu / rn
    a = -mu / (2.0 * energy) if abs(energy) > 1e-12 else float("inf")
    e_vec = np.cross(v, h) / mu - r / rn
    e = float(np.linalg.norm(e_vec))
    inc = float(np.degrees(np.arccos(np.clip(h[2] / hn, -1.0, 1.0))))
    n_vec = np.cross([0.0, 0.0, 1.0], h)
    nn = np.linalg.norm(n_vec)
    raan = float(np.degrees(np.arctan2(n_vec[1], n_vec[0]))) % 360.0 if nn > 1e-12 else 0.0
    if nn > 1e-12 and e > 1e-10:
        argp = float(np.degrees(np.arccos(np.clip(np.dot(n_vec, e_vec) / (nn * e), -1.0, 1.0))))
        if e_vec[2] < 0:
            argp = 360.0 - argp
    else:
        argp = 0.0
    if e > 1e-10:
        nu = float(np.degrees(np.arccos(np.clip(np.dot(e_vec, r) / (e * rn), -1.0, 1.0))))
        if np.dot(r, v) < 0:
            nu = 360.0 - nu
    else:
        nu = 0.0
    period = 2.0 * np.pi * np.sqrt(a ** 3 / mu) if a > 0 else float("inf")
    return {
        "a_km": float(a),
        "e": e,
        "inclination_deg": inc,
        "raan_deg": raan,
        "argp_deg": argp,
        "true_anomaly_deg": nu,
        "period_s": float(period),
        "perigee_alt_km": float(a * (1.0 - e) - R_EARTH_KM),
        "apogee_alt_km": float(a * (1.0 + e) - R_EARTH_KM),
    }


def circular_state(a_km: float, inc_deg: float, raan_deg: float, arg_lat_deg: float,
                   mu: float = MU_EARTH_KM3_S2):
    """Inertial position/velocity (km, km/s) on a circular orbit at argument of latitude u."""
    inc = np.radians(inc_deg)
    raan = np.radians(raan_deg)
    u = np.radians(arg_lat_deg)
    r_pf = a_km * np.array([np.cos(u), np.sin(u), 0.0])
    vmag = np.sqrt(mu / a_km)
    v_pf = vmag * np.array([-np.sin(u), np.cos(u), 0.0])
    cr, sr = np.cos(raan), np.sin(raan)
    ci, si = np.cos(inc), np.sin(inc)
    rot = np.array([
        [cr, -sr * ci, sr * si],
        [sr, cr * ci, -cr * si],
        [0.0, si, ci],
    ])
    return rot @ r_pf, rot @ v_pf


def earth_rotation_rate() -> float:
    return EARTH_ROTATION_RATE_RAD_S
