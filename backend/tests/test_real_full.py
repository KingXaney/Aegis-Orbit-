"""The real ISS scenario on the full CelesTrak snapshot: the fixed ML shortlist, the funnel, bounded payloads."""
import pytest

from app.config import get_settings
from app.perception import perception
from app.perception.model import NullRiskModel
from app.physics.screening import altitude_overlap_filter, screen
from app.scenarios import real
from app.scenarios.registry import build_real
from app.simulation import service
from app.simulation.session import SimulationSession

# keys the frontend and the sandbox tests read from screening stats
STATS_KEYS = {"duration_s", "window", "screening_radius_km", "candidates_after_altitude_filter", "complete"}
TRACKED = 18598  # objects besides the ISS in the 2026-10-17 snapshot


@pytest.fixture(scope="module")
def scen():
    return build_real()


def test_full_catalog_loads_every_tracked_object():
    cat = real.load_full_catalog()
    assert cat is not None and len(cat) == TRACKED + 1
    assert cat.require(real.PRIMARY_ID).name.strip() == "ISS (ZARYA)"
    names = [o.name.strip() for o in cat.values()]
    assert not [n for n in names if n.startswith("ISS (") and n != "ISS (ZARYA)"] and "POISK" not in names
    assert cat.source_info["retrieved_at"] == "2026-10-17T15:59:10Z" and cat.source_info["full_catalog"] is True


def test_real_scenario_uses_the_full_catalog_and_a_fixed_shortlist(scen):
    s = get_settings()
    assert len(scen.catalog) == TRACKED + 1
    sl = scen.screening_shortlist
    assert sl is not None and sl.catalog_total == TRACKED and 0 < sl.ml_flagged < TRACKED
    ids = set(sl.object_ids)
    primary = scen.catalog.require(scen.primary_id)
    band = altitude_overlap_filter(primary, scen.catalog.others(scen.primary_id), s.perception_guaranteed_band_margin_km)
    assert {o.object_id for o in band} <= ids and scen.primary_id not in ids
    assert s.perception_screen_top_k <= len(ids) <= s.perception_screen_top_k + len(band)
    assert sl.band_count == len(band) and sl.ml_top_k == s.perception_screen_top_k
    assert sl.public()["size"] == len(ids) and "object_ids" not in sl.public()
    # the scenario renders the primary and the shortlisted passes, not hundreds of background objects
    assert scen.rendered_object_ids[0] == scen.primary_id and set(scen.rendered_object_ids[1:]) <= ids


def test_shortlist_screen_finds_every_pass_a_full_band_screen_finds(scen):
    """The recall check behind the funnel: brute force over the whole altitude band vs the shortlist."""
    s = get_settings()
    got = service.run_screening(SimulationSession(scen))
    primary = scen.catalog.require(scen.primary_id)
    band = altitude_overlap_filter(primary, scen.catalog.others(scen.primary_id), s.altitude_filter_margin_km)
    assert len(band) > 5 * len(scen.screening_shortlist.object_ids)
    truth = []
    for i in range(0, len(band), 1500):  # chunks bound the batch-propagation memory
        truth += screen(primary, band[i:i + 1500], scen.start_unix, scen.end_unix,
                        screening_radius_km=s.screening_radius_km, coarse_step_s=s.screening_coarse_step_s,
                        altitude_margin_km=s.altitude_filter_margin_km,
                        co_orbital_min_speed_kms=s.co_orbital_min_relative_speed_kms,
                        numerical_step_s=s.planner_numerical_step_s).conjunctions
    assert truth
    assert {c.conjunction_id for c in truth} == {c["conjunction_id"] for c in got["conjunctions"]}
    stats = got["stats"]
    assert STATS_KEYS <= set(stats)
    assert stats["catalog_total"] == TRACKED
    assert stats["shortlist"]["size"] == stats["objects_total"] == len(scen.screening_shortlist.object_ids)


def test_object_list_is_bounded_and_cloud_rows_cover_the_catalog(client):
    d = client.get("/api/objects", params={"scenario_id": real.SCENARIO_ID}).json()
    assert d["partial"] is True and d["catalog_total"] == TRACKED and len(d["objects"]) < 600
    assert real.PRIMARY_ID in {o["object_id"] for o in d["objects"]}
    t = client.get(f"/api/scenarios/{real.SCENARIO_ID}/catalog-tles").json()
    assert t["count"] == len(t["rows"]) == TRACKED and t["fields"] == ["object_id", "name", "category", "line1", "line2"]
    oid, name, category, l1, l2 = t["rows"][0]
    assert l1.startswith("1 ") and l2.startswith("2 ") and category in ("PAYLOAD", "DEBRIS", "ROCKET_BODY", "UNKNOWN")
    assert real.PRIMARY_ID not in {r[0] for r in t["rows"]}


def test_perception_reports_the_funnel(client):
    d = client.get("/api/perception", params={"scenario_id": real.SCENARIO_ID, "trails": False}).json()
    f = d["funnel"]
    assert d["screening_mode"] == "ML_PRIORITISED"
    assert f["tracked"] == TRACKED and f["ml_scored"] == TRACKED
    assert f["ml_flagged"] == len(f["flagged_ids"]) == d["counts"]["ml_flagged"]
    assert f["screened"] == len(f["screened_ids"]) == d["counts"]["physics_screened"]
    assert f["passes"] == d["counts"]["encounters"] >= len(f["confirmed_ids"]) > 0
    assert set(f["confirmed_ids"]) <= set(f["screened_ids"]) and f["critical_ids"] == []
    assert f["shortlist"]["ml_top_k"] == get_settings().perception_screen_top_k


def test_no_shortlist_for_small_catalogs_or_without_a_model(monkeypatch):
    small = real.load_fixture_catalog()  # the 400-object subset: screened in full
    primary = small.require(real.PRIMARY_ID)
    assert perception.screening_shortlist(primary, small.others(real.PRIMARY_ID), 0.0) is None
    full = real.load_full_catalog()
    p = full.require(real.PRIMARY_ID)
    assert perception.screening_shortlist(p, full.others(real.PRIMARY_ID), 0.0, model=NullRiskModel("test")) is None
    # without a model the scenario says so instead of silently screening 18k objects per request
    monkeypatch.setattr(perception, "load_risk_model", lambda *_: NullRiskModel("no model in this test"))
    scen = build_real()
    assert scen.screening_shortlist is None and scen.to_dict()["screening_shortlist"] is None
    assert any("No perception model could be loaded" in x for x in scen.disclaimers)
