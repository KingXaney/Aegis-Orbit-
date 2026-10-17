import numpy as np
import pytest

from app.physics.collision_probability import (POLICY_ILLUSTRATIVE_DEFAULT, compute_pc, compute_pc_for_conjunction,
                                               pc_2d, pc_isotropic_closed_form)
from app.scenarios import synthetic


@pytest.mark.parametrize("miss,sigma,hbr", [(0.0, 100.0, 10.0), (350.0, 300.0, 10.0), (50.0, 100.0, 10.0),
                                            (1000.0, 300.0, 10.0), (0.0, 50.0, 100.0), (20.0, 15.0, 30.0)])
def test_numerical_pc_matches_closed_form(miss, sigma, hbr):
    num = pc_2d(np.array([miss, 0.0]), np.diag([sigma ** 2, sigma ** 2]), hbr)
    exact = pc_isotropic_closed_form(miss, sigma, hbr)
    assert abs(num - exact) <= 1e-9 * max(exact, 1e-12) + 1e-15


def test_pc_rotation_invariance_and_monotonicity():
    cov = np.array([[300.0 ** 2, 0.3 * 300 * 900], [0.3 * 300 * 900, 900.0 ** 2]])
    th = 0.7
    R = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
    m = np.array([400.0, 150.0])
    assert np.isclose(pc_2d(m, cov, 10.0), pc_2d(R @ m, R @ cov @ R.T, 10.0), rtol=1e-9)
    values = [pc_2d(np.array([d, 0.0]), cov, 10.0) for d in (0.0, 200.0, 500.0, 1000.0, 3000.0)]
    assert all(a > b for a, b in zip(values, values[1:]))


def test_unverified_without_covariance(synthetic_catalog, synthetic_screening):
    conj = synthetic_screening.conjunctions[0]
    primary = synthetic_catalog.require(conj.primary_id)
    secondary = synthetic_catalog.require(conj.secondary_id)
    bare = secondary.__class__(**{**secondary.__dict__, "covariance_rtn_m2": None, "covariance_source": "UNAVAILABLE"})
    res = compute_pc_for_conjunction(conj, primary, bare)
    assert res.status == "UNVERIFIED" and res.value is None and res.covariance_basis == "UNAVAILABLE"
    assert "no position covariance" in res.reason
    res2 = compute_pc_for_conjunction(conj, primary, bare, POLICY_ILLUSTRATIVE_DEFAULT)
    assert res2.status == "COMPUTED" and res2.covariance_basis in ("ASSUMED_ILLUSTRATIVE", "MIXED")
    assert any("illustrative" in a for a in res2.assumptions)


def test_synthetic_pc_is_critical_and_labelled(synthetic_screening):
    conj = synthetic_screening.conjunctions[0]
    assert conj.pc.status == "COMPUTED" and conj.pc.covariance_basis == "ASSUMED_ILLUSTRATIVE"
    assert 1e-4 < conj.pc.value < 1e-2
    assert conj.pc.hard_body_radius_m == 10.0 and "SCENARIO_DEFINITION" in conj.pc.hard_body_radius_basis
    assert conj.threat_state == "CRITICAL"
    plane = conj.pc.encounter_plane
    e1, e2, w = (np.array(plane[k]) for k in ("e1_teme", "e2_teme", "relative_velocity_direction_teme"))
    assert abs(np.dot(e1, w)) < 1e-9 and abs(np.dot(e2, w)) < 1e-9 and abs(np.dot(e1, e2)) < 1e-9
    assert abs(np.linalg.norm(plane["miss_vector_m"]) - conj.miss_distance_km * 1000) < 1e-6


def test_small_hbr_limit(synthetic_catalog):
    primary = synthetic_catalog.require(synthetic.PRIMARY_ID)
    secondary = synthetic_catalog.require(synthetic.SECONDARY_ID)
    r = np.array([7000.0, 0.0, 0.0]); v = np.array([0.0, 7.5, 0.0])
    rel_r = np.array([0.0, 0.0, 0.0]); rel_v = np.array([0.0, -7.0, 7.0])
    res = compute_pc(rel_r, rel_v, r, v, r, v + rel_v, primary, secondary)
    cov = np.array(res.encounter_plane["combined_covariance_m2"])
    approx = np.pi * res.hard_body_radius_m ** 2 / (2 * np.pi * np.sqrt(np.linalg.det(cov)))
    assert abs(res.value - approx) / approx < 0.02
