"""Pairwise orbital features for the collision-risk ranker.

Every feature is computed from the objects' *elements only* (no propagation),
so scoring a whole catalog costs milliseconds. The feature list is the model
contract: ``FEATURE_NAMES`` is stored in the model metadata and checked when a
model is loaded. The model only ranks; the physics screening verifies.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence

import numpy as np

from ..data.catalog import OrbitalObject
from ..physics.constants import MU_EARTH_KM3_S2, R_EARTH_KM
from ..physics.frames import osculating_elements

FEATURE_VERSION = 1
FEATURE_NAMES: List[str] = [
    # primary-side (lets the model learn altitude-shell base rates)
    "a_p_km", "alt_p_km", "e_p", "inc_p_deg",
    # secondary-side
    "a_s_km", "e_s", "inc_s_deg", "per_s_km", "apo_s_km",
    # pairwise geometry
    "da_km", "abs_da_km", "overlap_depth_km",
    "plane_angle_deg", "draan_deg", "dinc_deg",
    "dr_node_1_km", "dr_node_2_km", "dr_node_min_abs_km", "coplanar_flag", "v_rel_node_kms",
    # pairwise dynamics / phasing
    "dn_rev_day", "log10_synodic_days", "du_deg",
    # data quality
    "epoch_age_s_days", "epoch_gap_days", "log10_abs_bstar", "ndot_s",
    # category one-hot
    "cat_payload", "cat_debris", "cat_rocket_body", "cat_unknown",
]
CATEGORY_COLUMNS = {"PAYLOAD": "cat_payload", "DEBRIS": "cat_debris", "ROCKET_BODY": "cat_rocket_body",
                    "UNKNOWN": "cat_unknown"}
TWO_PI = 2.0 * np.pi


@dataclass(frozen=True)
class MeanElements:
    a_km: float
    e: float
    inc_rad: float
    raan_rad: float
    argp_rad: float
    m_rad: float
    n_rad_s: float
    epoch_unix: float
    bstar: float
    ndot: float
    basis: str  # SGP4_MEAN | OSCULATING_AT_STATE_EPOCH


@dataclass
class FeatureMatrix:
    X: np.ndarray  # (N, F) float64, NaN rows where elements are unavailable
    names: List[str]
    ok_mask: np.ndarray  # (N,) bool
    basis: List[Optional[str]]  # per object
    primary_basis: str
    object_ids: List[str]


def elements_of(obj: OrbitalObject) -> Optional[MeanElements]:
    """Mean elements for SGP4 records; osculating elements at the state epoch for numerical objects."""
    if obj.satrec is not None and obj.epoch_unix is not None:
        s = obj.satrec
        n = float(s.no_kozai) / 60.0  # rad/s
        if n <= 0:
            return None
        a = (MU_EARTH_KM3_S2 / (n * n)) ** (1.0 / 3.0)
        return MeanElements(a, float(s.ecco), float(s.inclo), float(s.nodeo), float(s.argpo), float(s.mo) % TWO_PI,
                            n, float(obj.epoch_unix), float(s.bstar), float(s.ndot), "SGP4_MEAN")
    if obj.r0_teme_km is not None and obj.v0_teme_kms is not None and obj.state_epoch_unix is not None:
        el = osculating_elements(obj.r0_teme_km, obj.v0_teme_kms)
        a = el["a_km"]
        if not np.isfinite(a) or a <= 0:
            return None
        e = el["e"]
        # Argument of latitude straight from the state (osculating_elements reports nu = argp = 0 for
        # circular orbits, which would lose the phase); nu = u - argp.
        r = np.asarray(obj.r0_teme_km, dtype=float)
        inc, raan = np.radians(el["inclination_deg"]), np.radians(el["raan_deg"])
        node = np.array([np.cos(raan), np.sin(raan), 0.0])
        h_hat = plane_normal(inc, raan)
        u = np.arctan2(np.dot(r, np.cross(h_hat, node)), np.dot(r, node))
        nu = u - np.radians(el["argp_deg"])
        ecc_anom = 2.0 * np.arctan2(np.sqrt(1.0 - e) * np.sin(nu / 2.0), np.sqrt(1.0 + e) * np.cos(nu / 2.0))
        m = (ecc_anom - e * np.sin(ecc_anom)) % TWO_PI
        n = float(np.sqrt(MU_EARTH_KM3_S2 / a ** 3))
        return MeanElements(float(a), float(e), np.radians(el["inclination_deg"]), np.radians(el["raan_deg"]),
                            np.radians(el["argp_deg"]), float(m), n, float(obj.state_epoch_unix), 0.0, 0.0,
                            "OSCULATING_AT_STATE_EPOCH")
    return None


def elements_array(objects: Sequence[OrbitalObject]):
    """(N,10) element array [a, e, inc, raan, argp, M, n, epoch, bstar, ndot], ok mask, basis list."""
    n = len(objects)
    E = np.full((n, 10), np.nan)
    ok = np.zeros(n, dtype=bool)
    basis: List[Optional[str]] = [None] * n
    for i, o in enumerate(objects):
        el = elements_of(o)
        if el is None:
            continue
        E[i] = [el.a_km, el.e, el.inc_rad, el.raan_rad, el.argp_rad, el.m_rad, el.n_rad_s, el.epoch_unix, el.bstar, el.ndot]
        ok[i] = True
        basis[i] = el.basis
    return E, ok, basis


def plane_normal(inc_rad, raan_rad) -> np.ndarray:
    """Unit angular-momentum direction of an orbit plane (works on arrays; last axis = xyz)."""
    inc = np.asarray(inc_rad, dtype=float)
    raan = np.asarray(raan_rad, dtype=float)
    return np.stack([np.sin(inc) * np.sin(raan), -np.sin(inc) * np.cos(raan), np.cos(inc)], axis=-1)


def perigee_direction(inc_rad, raan_rad, argp_rad) -> np.ndarray:
    inc = np.asarray(inc_rad, dtype=float)
    raan = np.asarray(raan_rad, dtype=float)
    w = np.asarray(argp_rad, dtype=float)
    return np.stack([
        np.cos(raan) * np.cos(w) - np.sin(raan) * np.sin(w) * np.cos(inc),
        np.sin(raan) * np.cos(w) + np.cos(raan) * np.sin(w) * np.cos(inc),
        np.sin(w) * np.sin(inc),
    ], axis=-1)


def radius_along(a, e, p_hat, q_hat, k_hat) -> np.ndarray:
    """Orbit radius (km) in the direction k_hat (unit, in the orbit plane)."""
    nu = np.arctan2(np.sum(k_hat * q_hat, axis=-1), np.sum(k_hat * p_hat, axis=-1))
    return a * (1.0 - e * e) / (1.0 + e * np.cos(nu))


def wrap_pi(x: np.ndarray) -> np.ndarray:
    return (np.asarray(x, dtype=float) + np.pi) % TWO_PI - np.pi


def pair_features(primary: OrbitalObject, objects: Sequence[OrbitalObject], t_ref_unix: float) -> FeatureMatrix:
    """Feature matrix of every object paired with the primary (rows of NaN where elements are missing)."""
    ep = elements_of(primary)
    if ep is None:
        raise ValueError(f"primary {primary.object_id} has no usable orbital elements")
    E, ok, basis = elements_array(objects)
    n = len(objects)
    F = len(FEATURE_NAMES)
    X = np.full((n, F), np.nan)
    if n == 0:
        return FeatureMatrix(X, list(FEATURE_NAMES), ok, basis, ep.basis, [])
    idx = {name: i for i, name in enumerate(FEATURE_NAMES)}

    a_s, e_s, i_s, O_s, w_s, M_s, n_s, t_s, b_s, nd_s = (E[:, k] for k in range(10))
    a_p, e_p, i_p, O_p, w_p, M_p, n_p, t_p = ep.a_km, ep.e, ep.inc_rad, ep.raan_rad, ep.argp_rad, ep.m_rad, ep.n_rad_s, ep.epoch_unix

    hp = plane_normal(i_p, O_p)
    Pp = perigee_direction(i_p, O_p, w_p)
    Qp = np.cross(hp, Pp)
    hs = plane_normal(i_s, O_s)
    Ps = perigee_direction(i_s, O_s, w_s)
    Qs = np.cross(hs, Ps)

    cr = np.cross(hp[None, :], hs)
    sin_psi = np.linalg.norm(cr, axis=1)
    cos_psi = hs @ hp
    psi = np.arctan2(sin_psi, cos_psi)
    coplanar = sin_psi < 1e-4
    with np.errstate(invalid="ignore", divide="ignore"):
        k_hat = cr / np.where(coplanar, 1.0, sin_psi)[:, None]
    r_p_plus = radius_along(a_p, e_p, Pp[None, :], Qp[None, :], k_hat)
    r_p_minus = radius_along(a_p, e_p, Pp[None, :], Qp[None, :], -k_hat)
    r_s_plus = radius_along(a_s, e_s, Ps, Qs, k_hat)
    r_s_minus = radius_along(a_s, e_s, Ps, Qs, -k_hat)
    dr1 = r_s_plus - r_p_plus
    dr2 = r_s_minus - r_p_minus
    dr1 = np.where(coplanar, a_s - a_p, dr1)
    dr2 = np.where(coplanar, a_s - a_p, dr2)
    swap = np.abs(dr2) < np.abs(dr1)
    dr_node_1 = np.where(swap, dr2, dr1)
    dr_node_2 = np.where(swap, dr1, dr2)

    per_p, apo_p = a_p * (1.0 - e_p) - R_EARTH_KM, a_p * (1.0 + e_p) - R_EARTH_KM
    per_s, apo_s = a_s * (1.0 - e_s) - R_EARTH_KM, a_s * (1.0 + e_s) - R_EARTH_KM
    overlap = np.minimum(apo_p, apo_s) - np.maximum(per_p, per_s)
    a_bar = 0.5 * (a_p + a_s)
    with np.errstate(invalid="ignore", divide="ignore"):
        v_rel_node = 2.0 * np.sqrt(MU_EARTH_KM3_S2 / a_bar) * np.sin(psi / 2.0)
        dn = (n_s - n_p) * 86400.0 / TWO_PI
        synodic = np.log10(np.minimum(1.0 / np.maximum(np.abs(dn), 1e-3), 1000.0))
    u_p = w_p + M_p + n_p * (t_ref_unix - t_p)
    u_s = w_s + M_s + n_s * (t_ref_unix - t_s)
    du = np.degrees(wrap_pi(u_s - u_p))

    X[:, idx["a_p_km"]] = a_p
    X[:, idx["alt_p_km"]] = a_p - R_EARTH_KM
    X[:, idx["e_p"]] = e_p
    X[:, idx["inc_p_deg"]] = np.degrees(i_p)
    X[:, idx["a_s_km"]] = a_s
    X[:, idx["e_s"]] = e_s
    X[:, idx["inc_s_deg"]] = np.degrees(i_s)
    X[:, idx["per_s_km"]] = per_s
    X[:, idx["apo_s_km"]] = apo_s
    X[:, idx["da_km"]] = a_s - a_p
    X[:, idx["abs_da_km"]] = np.abs(a_s - a_p)
    X[:, idx["overlap_depth_km"]] = overlap
    X[:, idx["plane_angle_deg"]] = np.degrees(psi)
    X[:, idx["draan_deg"]] = np.degrees(wrap_pi(O_s - O_p))
    X[:, idx["dinc_deg"]] = np.degrees(i_s - i_p)
    X[:, idx["dr_node_1_km"]] = dr_node_1
    X[:, idx["dr_node_2_km"]] = dr_node_2
    X[:, idx["dr_node_min_abs_km"]] = np.minimum(np.abs(dr_node_1), np.abs(dr_node_2))
    X[:, idx["coplanar_flag"]] = coplanar.astype(float)
    X[:, idx["v_rel_node_kms"]] = v_rel_node
    X[:, idx["dn_rev_day"]] = dn
    X[:, idx["log10_synodic_days"]] = synodic
    X[:, idx["du_deg"]] = du
    X[:, idx["epoch_age_s_days"]] = (t_ref_unix - t_s) / 86400.0
    X[:, idx["epoch_gap_days"]] = (t_s - t_p) / 86400.0
    X[:, idx["log10_abs_bstar"]] = np.log10(np.abs(b_s) + 1e-7)
    X[:, idx["ndot_s"]] = nd_s
    for i, o in enumerate(objects):
        col = CATEGORY_COLUMNS.get(o.category, "cat_unknown")
        for c in CATEGORY_COLUMNS.values():
            X[i, idx[c]] = 0.0
        X[i, idx[col]] = 1.0
    X[~ok] = np.nan
    return FeatureMatrix(X, list(FEATURE_NAMES), ok, basis, ep.basis, [o.object_id for o in objects])
