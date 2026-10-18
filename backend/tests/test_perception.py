import numpy as np
import pytest

from app.perception import perception as perc
from app.perception.model import ModelInfo, NullRiskModel
from app.scenarios import synthetic
from app.simulation import service
from app.simulation.session import SessionStore

SID = synthetic.SCENARIO_ID


class StubModel:
    """Scores one chosen object high, everything else low."""

    def __init__(self, high_id, ids, score=0.99):
        self.high_id, self.ids, self.score = high_id, ids, score
        self.info = ModelInfo(status="LOADED", library="stub", model_version="stub-1", threshold=0.5)

    def predict_proba(self, X):
        return np.array([self.score if oid == self.high_id else 0.01 for oid in self.ids])


@pytest.fixture()
def session():
    return SessionStore().get(SID)


@pytest.fixture()
def null_model():
    return NullRiskModel("test: no model")


def test_physics_only_tiers_on_synthetic(session, null_model):
    res = perc.perceive(session, model=null_model)
    crit = [o for o in res["objects"] if o["tier"] == "CRITICAL"]
    semi = [o for o in res["objects"] if o["tier"] == "SEMI_CRITICAL"]
    assert sorted(o["object_id"] for o in crit) == sorted(synthetic.CRITICAL_STAGED_IDS)
    deb = next(o for o in crit if o["object_id"] == synthetic.SECONDARY_ID)
    assert abs(deb["physics"]["miss_distance_km"] - 0.3535) < 2e-3 and deb["physics"]["verified"]
    # the semi-critical entries are the staged objects on their other, farther passes (one per encounter)
    staged = {p.object_id for p in synthetic.STAGED_PASSES}
    assert semi and all(o["object_id"] in staged for o in semi)
    assert len(semi) == res["counts"]["encounters"] - len(crit)
    assert res["counts"]["ML_WATCH"] == 0 and res["counts"]["HIDDEN"] == 5 and res["model"]["status"] == "UNAVAILABLE"
    assert res["screening_mode"] == "FULL_PHYSICS" and res["complete"] and res["primary_variant"]["kind"] == "ORIGINAL"
    assert res["horizon"]["horizon_s"] >= 2 * (session.scenario.catalog.require(synthetic.PRIMARY_ID).period_s or 0)
    rtn = np.array(crit[0]["physics"]["miss_vector_rtn_km"])
    assert abs(np.linalg.norm(rtn) - crit[0]["physics"]["miss_distance_km"]) < 1e-6
    vr = np.array(crit[0]["physics"]["relative_velocity_rtn_kms"])
    assert abs(np.linalg.norm(vr) - crit[0]["physics"]["relative_speed_kms"]) < 5e-3  # co-moving vs inertial differ by omega x r
    trail = crit[0]["trail"]
    assert trail and len(trail["positions_rtn_km"]) == 37
    centre = np.array(trail["positions_rtn_km"][18])
    assert abs(np.linalg.norm(centre) - crit[0]["physics"]["miss_distance_km"]) < 1e-6
    assert all(e["rank"] == i + 1 for i, e in enumerate(res["objects"]))


def test_hidden_objects_are_cleared_by_physics(session, null_model):
    res = perc.perceive(session, model=null_model, include_hidden=True)
    hidden = [o for o in res["objects"] if o["tier"] == "HIDDEN"]
    assert len(hidden) == 5
    assert all(o["physics"]["status"] == "CLEARED" and o["physics"]["clearance"] for o in hidden)
    assert all(o["physics"]["coarse_min_distance_km"] is None or o["physics"]["coarse_min_distance_km"] > 25 for o in hidden)
    assert any("band filter" in o["physics"]["clearance"] for o in hidden)  # SYN-RB-7 at 610 km never needs propagation
    assert all(o["physics"]["verified"] and o["ml"]["basis"] == "UNAVAILABLE" for o in hidden)


def test_model_can_only_add_watch_tier(session):
    ids = [o.object_id for o in session.scenario.catalog.others(synthetic.PRIMARY_ID) if o.validation_status != "INVALID"]
    res = perc.perceive(session, model=StubModel("SYN-DEB-902", ids))
    watch = [o for o in res["objects"] if o["tier"] == "ML_WATCH"]
    assert [o["object_id"] for o in watch] == ["SYN-DEB-902"]
    assert watch[0]["physics"]["status"] == "CLEARED" and watch[0]["ml"]["predicted_tier"] == "WATCH"
    assert watch[0]["ml"]["score"] == 0.99 and watch[0]["physics"]["miss_distance_km"] is None
    crit = [o for o in res["objects"] if o["tier"] == "CRITICAL"]
    assert crit[0]["object_id"] == synthetic.SECONDARY_ID and crit[0]["ml"]["predicted_tier"] == "CLEAR"
    assert "ML_WATCH: model score" in " ".join(res["tier_rules"])


def test_linking_and_cache(session, null_model):
    first = perc.perceive(session, model=null_model)
    assert first["cached"] is False and first["objects"][0]["physics"]["linked_conjunction_id"] is None
    again = perc.perceive(session, model=null_model)
    assert again["cached"] is True
    service.run_screening(session)  # invalidates and makes the ids linkable
    res = perc.perceive(session, model=null_model)
    assert res["cached"] is False
    assert res["objects"][0]["physics"]["linked_conjunction_id"] in session.conjunctions
    assert res["objects"][0]["physics"]["link_basis"] == "exact"


def test_approved_maneuver_changes_the_perceived_encounter(session, null_model):
    service.run_screening(session)
    cid = next(iter(session.conjunctions))
    plan = service.plan_for_conjunction(session, cid, max_candidates=3)
    mid = plan["recommended_ids"][0]
    cand = session.maneuvers[mid]
    preview = perc.perceive(session, maneuver_id=mid, model=null_model)
    assert preview["primary_variant"]["kind"] == "CANDIDATE"
    service.approve(session, mid)
    res = perc.perceive(session, model=null_model)
    assert res["primary_variant"]["kind"] == "APPROVED" and len(res["primary_variant"]["segments"]) == 2
    deb = [o for o in res["objects"] if o["object_id"] == synthetic.SECONDARY_ID]
    closest = min(deb, key=lambda o: o["physics"]["miss_distance_km"])
    assert closest["tier"] != "CRITICAL"
    assert abs(closest["physics"]["miss_distance_km"] - cand.post_miss_distance_km) < 0.05
    assert closest["physics"]["segment"] == "post-burn"


def test_invalid_radii_and_unknown_maneuver(session, null_model):
    with pytest.raises(ValueError):
        perc.perceive(session, critical_radius_km=30.0, tracked_radius_km=25.0, model=null_model)
    with pytest.raises(KeyError):
        perc.perceive(session, maneuver_id="MV-nope", model=null_model)
