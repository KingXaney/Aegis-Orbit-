from app.physics.secondary_screening import check_secondary
from app.scenarios import synthetic


def test_best_candidate_passes_secondary_screening(synthetic_catalog, synthetic_window, synthetic_screening, synthetic_plan):
    primary = synthetic_catalog.require(synthetic.PRIMARY_ID)
    best = next(c for c in synthetic_plan.candidates if c.maneuver_id == synthetic_plan.recommended_ids[0])
    res = check_secondary(best, primary, synthetic_catalog.others(synthetic.PRIMARY_ID), synthetic_window["end_unix"],
                          synthetic_screening.conjunctions)
    assert res["validation_status"] == "PASS" and res["complete"]
    # the burn may nudge a repeat pass of another staged object inside the screening radius, never more
    staged = {p.object_id for p in synthetic.STAGED_PASSES}
    assert all(c["secondary_id"] in staged and c["threat_state"] in ("NORMAL", "MONITORING") for c in res["new_conjunctions"])
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


def test_incomplete_screen_cannot_mask_a_failure(synthetic_catalog, synthetic_window, synthetic_screening, synthetic_plan, monkeypatch):
    from app.physics import secondary_screening as ss
    from app.physics.screening import ScreeningResult

    weak = next(c for c in synthetic_plan.candidates if c.feasible and not c.meets_target)
    primary = synthetic_catalog.require(synthetic.PRIMARY_ID)
    real_screen = ss.screen

    def incomplete(*args, **kwargs):
        res = real_screen(*args, **kwargs)
        res.stats["complete"] = False
        return res

    monkeypatch.setattr(ss, "screen", incomplete)
    res = ss.check_secondary(weak, primary, synthetic_catalog.others(synthetic.PRIMARY_ID), synthetic_window["end_unix"],
                             synthetic_screening.conjunctions)
    assert res["validation_status"] == "FAIL" and res["complete"] is False
