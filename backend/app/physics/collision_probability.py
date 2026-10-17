"""Collision probability (Pc) with the two-dimensional encounter-plane method
(Foster & Estes 1992 / Alfano style).

Assumptions of the method, all reported with the result:
* relative motion is rectilinear through the encounter (valid for short,
  high-relative-speed encounters);
* position errors are Gaussian, independent between the two objects and
  constant during the encounter, so the combined covariance is the sum;
* velocity uncertainty is neglected;
* both objects are spheres; the hard-body radius is the sum of their radii.

Public GP elements carry **no covariance**. When an object has no covariance
the function returns ``UNVERIFIED`` unless the caller explicitly selects the
``illustrative_default`` policy, in which case documented placeholder sigmas
are used and the result is labelled ``ASSUMED_ILLUSTRATIVE``. Such a number is
useful for demonstrating the workflow; it is **not** an operational risk
estimate.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from scipy.stats import ncx2

from ..data.catalog import OrbitalObject
from .frames import covariance_rtn_to_inertial

METHOD = "Foster 2D encounter-plane method, numerical polar quadrature (Gauss-Legendre x trapezoid)"

# Illustrative placeholder 1-sigma position uncertainties (metres, RTN) used only
# under the ``illustrative_default`` policy. Loosely representative of TLE-class
# accuracy near epoch; not derived from any real covariance.
ILLUSTRATIVE_SIGMAS_RTN_M = {
    "PAYLOAD": (200.0, 1000.0, 200.0),
    "ROCKET_BODY": (300.0, 1500.0, 300.0),
    "DEBRIS": (300.0, 2000.0, 300.0),
    "UNKNOWN": (300.0, 2000.0, 300.0),
}

POLICY_PROVIDED_ONLY = "provided_only"
POLICY_ILLUSTRATIVE_DEFAULT = "illustrative_default"


@dataclass
class PcResult:
    status: str  # COMPUTED | UNVERIFIED
    value: Optional[float]
    covariance_basis: str  # PROVIDED | ASSUMED_ILLUSTRATIVE | MIXED | UNAVAILABLE
    hard_body_radius_m: float
    hard_body_radius_basis: str
    miss_distance_m: float
    method: str = METHOD
    policy: str = POLICY_PROVIDED_ONLY
    encounter_plane: Dict[str, Any] = field(default_factory=dict)
    assumptions: List[str] = field(default_factory=list)
    reason: Optional[str] = None
    inputs: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "value": self.value,
            "covariance_basis": self.covariance_basis,
            "hard_body_radius_m": self.hard_body_radius_m,
            "hard_body_radius_basis": self.hard_body_radius_basis,
            "miss_distance_m": self.miss_distance_m,
            "method": self.method,
            "policy": self.policy,
            "encounter_plane": self.encounter_plane,
            "assumptions": list(self.assumptions),
            "reason": self.reason,
            "inputs": self.inputs,
        }


BASE_ASSUMPTIONS = [
    "relative motion rectilinear through the encounter",
    "Gaussian position errors, independent between objects, constant during the encounter",
    "velocity uncertainty neglected",
    "spherical objects; hard-body radius = sum of the two radii",
]


def encounter_plane_basis(rel_r: np.ndarray, rel_v: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Orthonormal basis (e1, e2) of the plane perpendicular to the relative velocity.
    e1 points along the in-plane component of the miss vector."""
    w = rel_v / np.linalg.norm(rel_v)
    r_perp = rel_r - np.dot(rel_r, w) * w
    if np.linalg.norm(r_perp) < 1e-9:
        # degenerate (zero miss): pick any direction perpendicular to w
        trial = np.array([1.0, 0.0, 0.0]) if abs(w[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        r_perp = trial - np.dot(trial, w) * w
    e1 = r_perp / np.linalg.norm(r_perp)
    e2 = np.cross(w, e1)
    return e1, e2, w


def project_covariance(cov3: np.ndarray, e1: np.ndarray, e2: np.ndarray) -> np.ndarray:
    P = np.column_stack([e1, e2])
    return P.T @ cov3 @ P


def pc_2d(miss_m: np.ndarray, cov2_m2: np.ndarray, hbr_m: float, n_r: int = 48, n_theta: int = 256) -> float:
    """Probability mass of N(0, cov2) inside the disk of radius hbr centred at miss."""
    cov2 = np.asarray(cov2_m2, dtype=float)
    det = float(np.linalg.det(cov2))
    if det <= 0 or hbr_m <= 0:
        return 0.0
    inv = np.linalg.inv(cov2)
    norm = 1.0 / (2.0 * np.pi * np.sqrt(det))
    # Gauss-Legendre nodes on [0, hbr] for the radial integral, trapezoid in angle
    x, wts = np.polynomial.legendre.leggauss(n_r)
    rho = 0.5 * hbr_m * (x + 1.0)
    w_rho = 0.5 * hbr_m * wts
    theta = np.linspace(0.0, 2.0 * np.pi, n_theta, endpoint=False)
    w_theta = 2.0 * np.pi / n_theta
    px = miss_m[0] + np.outer(rho, np.cos(theta))
    py = miss_m[1] + np.outer(rho, np.sin(theta))
    quad = inv[0, 0] * px * px + 2.0 * inv[0, 1] * px * py + inv[1, 1] * py * py
    pdf = norm * np.exp(-0.5 * quad)
    inner = pdf.sum(axis=1) * w_theta  # integrate over theta
    return float(np.sum(inner * rho * w_rho))


def pc_isotropic_closed_form(miss_m: float, sigma_m: float, hbr_m: float) -> float:
    """Exact Pc for an isotropic 2D Gaussian (used to validate pc_2d):
    |X|^2/sigma^2 ~ non-central chi-square(2, lambda = d^2/sigma^2)."""
    return float(ncx2.cdf((hbr_m / sigma_m) ** 2, 2, (miss_m / sigma_m) ** 2))


def _object_covariance(obj: OrbitalObject, policy: str) -> Tuple[Optional[np.ndarray], str]:
    if obj.covariance_rtn_m2 is not None:
        return np.asarray(obj.covariance_rtn_m2, dtype=float), obj.covariance_source
    if policy == POLICY_ILLUSTRATIVE_DEFAULT:
        s = ILLUSTRATIVE_SIGMAS_RTN_M.get(obj.category, ILLUSTRATIVE_SIGMAS_RTN_M["UNKNOWN"])
        return np.diag([s[0] ** 2, s[1] ** 2, s[2] ** 2]), "ASSUMED_ILLUSTRATIVE"
    return None, "UNAVAILABLE"


def compute_pc(rel_r_km: np.ndarray, rel_v_kms: np.ndarray, primary_r_km: np.ndarray, primary_v_kms: np.ndarray,
               secondary_r_km: np.ndarray, secondary_v_kms: np.ndarray, primary: OrbitalObject,
               secondary: OrbitalObject, policy: str = POLICY_PROVIDED_ONLY,
               extra_assumptions: Optional[List[str]] = None) -> PcResult:
    """Collision probability for an encounter described by the relative state at TCA (TEME, km)."""
    rel_r = np.asarray(rel_r_km, dtype=float) * 1000.0
    rel_v = np.asarray(rel_v_kms, dtype=float) * 1000.0
    hbr = float(primary.radius_m + secondary.radius_m)
    hbr_basis = (f"sum of object radii: primary {primary.radius_m:g} m ({primary.radius_basis}), "
                 f"secondary {secondary.radius_m:g} m ({secondary.radius_basis})")
    miss_m = float(np.linalg.norm(rel_r))
    assumptions = list(BASE_ASSUMPTIONS) + list(extra_assumptions or [])

    cov_p, basis_p = _object_covariance(primary, policy)
    cov_s, basis_s = _object_covariance(secondary, policy)
    if cov_p is None or cov_s is None:
        missing = [o.object_id for o, c in ((primary, cov_p), (secondary, cov_s)) if c is None]
        return PcResult(status="UNVERIFIED", value=None, covariance_basis="UNAVAILABLE", hard_body_radius_m=hbr,
                        hard_body_radius_basis=hbr_basis, miss_distance_m=miss_m, policy=policy,
                        assumptions=assumptions,
                        reason=f"no position covariance available for {', '.join(missing)}; public GP elements do "
                               f"not include uncertainty, so a defensible collision probability cannot be computed "
                               f"(policy '{policy}')",
                        inputs={"primary_covariance": basis_p, "secondary_covariance": basis_s})

    if basis_p == "PROVIDED" and basis_s == "PROVIDED":
        basis = "PROVIDED"
    elif basis_p == basis_s:
        basis = basis_p
    else:
        basis = "MIXED"

    cov_p_i = covariance_rtn_to_inertial(cov_p, primary_r_km, primary_v_kms)
    cov_s_i = covariance_rtn_to_inertial(cov_s, secondary_r_km, secondary_v_kms)
    cov_c = cov_p_i + cov_s_i
    e1, e2, w = encounter_plane_basis(rel_r, rel_v)
    cov2 = project_covariance(cov_c, e1, e2)
    miss2 = np.array([np.dot(rel_r, e1), np.dot(rel_r, e2)])
    value = pc_2d(miss2, cov2, hbr)
    eig = np.linalg.eigvalsh(cov2)
    if basis != "PROVIDED":
        assumptions.append("covariance values are illustrative assumptions, not measured uncertainties")
    return PcResult(
        status="COMPUTED", value=float(value), covariance_basis=basis, hard_body_radius_m=hbr,
        hard_body_radius_basis=hbr_basis, miss_distance_m=miss_m, policy=policy,
        encounter_plane={
            "e1_teme": [float(x) for x in e1], "e2_teme": [float(x) for x in e2],
            "relative_velocity_direction_teme": [float(x) for x in w],
            "miss_vector_m": [float(x) for x in miss2],
            "combined_covariance_m2": [[float(cov2[0, 0]), float(cov2[0, 1])], [float(cov2[1, 0]), float(cov2[1, 1])]],
            "sigma_major_m": float(np.sqrt(max(eig[1], 0.0))), "sigma_minor_m": float(np.sqrt(max(eig[0], 0.0))),
        },
        assumptions=assumptions,
        inputs={
            "primary_covariance": basis_p, "secondary_covariance": basis_s,
            "primary_sigmas_rtn_m": [float(np.sqrt(cov_p[i, i])) for i in range(3)],
            "secondary_sigmas_rtn_m": [float(np.sqrt(cov_s[i, i])) for i in range(3)],
        },
    )


def compute_pc_for_conjunction(conj, primary: OrbitalObject, secondary: OrbitalObject,
                               policy: str = POLICY_PROVIDED_ONLY) -> PcResult:
    return compute_pc(conj.relative_position_teme_km, conj.relative_velocity_teme_kms, conj.primary_r_km,
                      conj.primary_v_kms, conj.secondary_r_km, conj.secondary_v_kms, primary, secondary, policy)
