"""Drill threat on the real ISS scenario: inject, detect, plan, check, approve, reset."""
from app.physics.time_utils import iso
from app.scenarios import real, synthetic
from app.simulation import drill

SID = real.SCENARIO_ID


def _start(client, sid):
    return client.get(f"/api/scenarios/{sid}").json()["window"]["start"]


def test_drill_runs_through_detection_planning_and_approval(client):
    client.post(f"/api/scenarios/{SID}/reset")
    start = _start(client, SID)
    r = client.post(f"/api/scenarios/{SID}/drill", json={"now": start})
    assert r.status_code == 200, r.text
    d = r.json()
    obj = d["object"]
    assert obj["object_id"] == drill.DRILL_ID and obj["source"] == "drill" and "DRILL" in obj["name"]
    assert obj["position_basis"] == "DRILL_INJECTED" and obj["spawned_at_unix"] is not None
    assert d["designed"]["miss_km"] < 1.0

    # the injected pass is screened, rendered, highlighted and listed
    c = next(c for c in d["screening"]["conjunctions"] if c["secondary_id"] == drill.DRILL_ID)
    assert c["miss_distance_km"] < 1.0
    detail = client.get(f"/api/scenarios/{SID}").json()
    assert drill.DRILL_ID in detail["rendered_object_ids"] and drill.DRILL_ID in detail["highlight_object_ids"]
    assert any("drill" in x.lower() for x in detail["disclaimers"])
    listed = client.get("/api/objects", params={"scenario_id": SID}).json()
    assert drill.DRILL_ID in {o["object_id"] for o in listed["objects"]}

    # perception: the funnel's critical stage is the drill
    p = client.get("/api/perception", params={"scenario_id": SID, "trails": False}).json()
    assert drill.DRILL_ID in p["funnel"]["critical_ids"] and drill.DRILL_ID in p["funnel"]["screened_ids"]

    # one drill per session
    assert client.post(f"/api/scenarios/{SID}/drill", json={"now": start}).status_code == 409

    # plan → recommendations meet the 5 km target → secondary checks → approve one that passes
    assert len([x for x in d["screening"]["conjunctions"] if x["secondary_id"] == drill.DRILL_ID]) == 1  # no repeat passes
    plan = client.post(f"/api/conjunctions/{c['conjunction_id']}/maneuvers", json={"scenario_id": SID}).json()
    assert plan["recommended_ids"], plan
    docked = {x["object_id"] for x in d["screening"]["co_orbital"]}
    assert docked  # Progress MS-34 shares the station's elements
    passing = None
    for rec in plan["recommended_ids"]:
        m = next(x for x in plan["candidates"] if x["maneuver_id"] == rec)
        assert m["meets_target"] and m["post_miss_distance_km"] >= 5.0 and m["burn_time_unix"] >= d["now_unix"]
        sec = client.post(f"/api/maneuvers/{rec}/secondary-check", json={"scenario_id": SID}).json()
        assert sec["original_encounter"]["meets_target"]
        # the post-burn screen uses the baseline's fixed shortlist, less the vehicles docked to the station
        assert sec["stats"]["objects_total"] == len(p["funnel"]["screened_ids"]) - len(docked)
        assert not docked & {x["secondary_id"] for x in sec["new_conjunctions"]}
        if sec["validation_status"] == "PASS" and passing is None:
            passing = rec
    assert passing, "no recommended burn passes secondary screening"
    appr = client.post("/api/simulation/approve", json={"scenario_id": SID, "maneuver_id": passing})
    assert appr.status_code == 200, appr.text

    # reset removes the drill
    client.post(f"/api/scenarios/{SID}/reset")
    listed = client.get("/api/objects", params={"scenario_id": SID}).json()
    assert drill.DRILL_ID not in {o["object_id"] for o in listed["objects"]}
    assert drill.DRILL_ID not in client.get(f"/api/scenarios/{SID}").json()["rendered_object_ids"]


def test_drill_is_refused_outside_the_real_scenario_and_near_the_window_end(client):
    sid = synthetic.SCENARIO_ID
    assert client.post(f"/api/scenarios/{sid}/drill", json={"now": _start(client, sid)}).status_code == 409
    client.post(f"/api/scenarios/{SID}/reset")
    end = client.get(f"/api/scenarios/{SID}").json()["window"]["end"]
    assert client.post(f"/api/scenarios/{SID}/drill", json={"now": end}).status_code == 409


def test_drill_mid_window_validates_its_time_and_stays_out_of_the_cloud(client):
    client.post(f"/api/scenarios/{SID}/reset")
    detail = client.get(f"/api/scenarios/{SID}").json()
    w = detail["window"]
    rows_before = client.get(f"/api/scenarios/{SID}/catalog-tles").json()["count"]
    assert client.post(f"/api/scenarios/{SID}/drill", json={"now": "not a time"}).status_code == 400
    assert client.post(f"/api/scenarios/{SID}/drill", json={"now": "2020-01-01T00:00:00Z"}).status_code == 400
    mid = w["start_unix"] + 6 * 3600
    r = client.post(f"/api/scenarios/{SID}/drill", json={"now": iso(mid)})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["designed"]["tca_unix"] > mid
    c = next(c for c in d["screening"]["conjunctions"] if c["secondary_id"] == drill.DRILL_ID)
    assert abs(c["tca_unix"] - d["designed"]["tca_unix"]) < 60 and c["miss_distance_km"] < 1.0
    # the drill has no elements: it is drawn as an entity, not as a cloud point
    assert client.get(f"/api/scenarios/{SID}/catalog-tles").json()["count"] == rows_before
    client.post(f"/api/scenarios/{SID}/reset")
