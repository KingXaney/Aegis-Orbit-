from app.physics.secondary_screening import check_secondary
from app.scenarios import synthetic


def test_best_candidate_passes_secondary_screening(synthetic_catalog, synthetic_window, synthetic_screening, synthetic_plan):
    primary = synthetic_catalog.require(synthetic.PRIMARY_ID)
    best = next(c for c in synthetic_plan.candidates if c.maneuver_id == synthetic_plan.recommended_ids[0])
    res = check_secondary(best, primary, synthetic_catalog.others(synthetic.PRIMARY_ID), synthetic_window["end_unix"],
                          synthetic_screening.conjunctions)
    assert res["validation_status"] == "PASS" and res["complete"]
    assert res["new_conjunctions"] == []
    original = next(x for x in res["changed_conjunctions"] if x["conjunction_id"] == best.conjunction_id)
    assert original["after_miss_km"] > original["before_miss_km"]
    assert abs(original["after_miss_km"] - best.post_miss_distance_km) < 0.05
    assert any("catalog limited" in lim for lim in res["limitations"])


def test_candidate_missing_target_fails(synthetic_catalog, synthetic_window, synthetic_screening, synthetic_plan):
    primary = synthetic_catalog.require(synthetic.PRIMARY_ID)
    weak = next(c for c in synthetic_plan.candidates if c.feasible and not c.meets_target)
    res = check_secondary(weak, primary, synthetic_catalog.others(synthetic.PRIMARY_ID), synthetic_window["end_unix"],
                          synthetic_screening.conjunctions)
    assert res["validation_status"] == "FAIL"
    assert not res["original_encounter"]["meets_target"]
