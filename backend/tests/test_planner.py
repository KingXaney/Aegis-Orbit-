import numpy as np

from app.physics.frames import rtn_basis
from app.physics.maneuver_planner import DIRECTION_VECTORS, maneuvered_primary
from app.physics.propagation import propagate
from app.scenarios import synthetic


def test_plan_has_valid_ranked_candidates(synthetic_plan):
    cands = synthetic_plan.candidates
    assert len(cands) >= 60
    scores = [c.objective_score for c in cands]
    assert scores == sorted(scores)
    assert [c.rank for c in cands] == list(range(1, len(cands) + 1))
    rec = [c for c in cands if c.maneuver_id in synthetic_plan.recommended_ids]
    assert len(rec) == 3 and all(c.feasible and c.meets_target for c in rec)
    assert len({c.direction for c in rec}) >= 2  # diverse directions in the recommendation set
    assert rec[0].post_pc.status == "COMPUTED" and rec[0].post_pc.value < 1e-6


def test_delta_v_vectors_are_consistent(synthetic_plan):
    for c in synthetic_plan.candidates[:20]:
        assert np.isclose(np.linalg.norm(c.dv_rtn_mps), c.dv_magnitude_mps)
        basis = rtn_basis(c.burn_r_km, c.burn_v_pre_kms)
        assert np.allclose(basis @ c.dv_rtn_mps, c.dv_teme_mps)
        assert np.allclose(c.burn_v_post_kms - c.burn_v_pre_kms, c.dv_teme_mps / 1000.0)
        if c.direction == "+T":
            assert np.linalg.norm(c.burn_v_post_kms) > np.linalg.norm(c.burn_v_pre_kms)


def test_along_track_burn_changes_miss_distance_plausibly(synthetic_plan):
    cands = [c for c in synthetic_plan.candidates if c.direction in ("+T", "-T") and c.lead_orbits == 1.0
             and abs(c.dv_magnitude_mps - 0.1) < 1e-9]
    assert cands
    for c in cands:
        # ~3*dv*dt along-track displacement (0.1 m/s over one orbit ~ 1.7 km) projected into the encounter plane
        assert 0.4 < abs(c.post_miss_distance_km - c.baseline_miss_distance_km) < 5.0


def test_infeasible_candidates_are_rejected_with_reasons(synthetic_plan):
    rejected = [c for c in synthetic_plan.candidates if not c.feasible]
    assert rejected and all(c.validation_status == "REJECTED" and c.feasibility_reasons for c in rejected)
    assert all(c.objective_score >= 1000 for c in rejected)


def test_model_consistency_reported(synthetic_plan):
    rows = [r for r in synthetic_plan.baseline if "model_difference_km" in r]
    assert rows and all(abs(r["model_difference_km"]) < 1e-3 for r in rows)  # same model in the synthetic scenario


def test_maneuvered_primary_state_at_burn(synthetic_catalog, synthetic_plan):
    primary = synthetic_catalog.require(synthetic.PRIMARY_ID)
    cand = synthetic_plan.candidates[0]
    mp = maneuvered_primary(primary, cand)
    res = propagate(mp, np.array([cand.burn_time_unix]))
    assert np.allclose(res.positions_km[0], cand.burn_r_km)
    assert np.allclose(res.velocities_kms[0], cand.burn_v_post_kms)
    assert mp.propagation_model == "PIECEWISE_J2" and mp.base_model == "NUMERICAL_J2"
