from app.scenarios import real, synthetic

SID = synthetic.SCENARIO_ID


def test_health_and_scenarios(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert SID in r.json()["scenarios"]
    assert {s["scenario_id"] for s in client.get("/api/scenarios").json()} == {SID, real.SCENARIO_ID, synthetic.SANDBOX_SCENARIO_ID}
    d = client.get(f"/api/scenarios/{SID}").json()
    assert d["primary_id"] == synthetic.PRIMARY_ID and d["simulation"]["overall_threat_state"] == "NORMAL"
    assert client.get("/api/scenarios/nope").status_code == 404


def test_objects_and_trajectory(client):
    objs = client.get("/api/objects", params={"scenario_id": SID}).json()["objects"]
    # the primary, the staged passes and five background objects
    assert len(objs) == 1 + len(synthetic.STAGED_PASSES) + 5 and all(o["position_basis"] == "SYNTHETIC_STATE" for o in objs)
    d = client.get(f"/api/objects/{synthetic.PRIMARY_ID}", params={"scenario_id": SID}).json()
    assert d["state"]["status"] == "OK" and 400 < d["state"]["geocentric_altitude_km"] < 440
    assert "lat_deg" in d["state"]["geodetic"]
    t = client.get(f"/api/objects/{synthetic.PRIMARY_ID}/trajectory", params={"scenario_id": SID, "step_s": 120}).json()
    assert t["frame"] == "TEME" and t["units"]["position"] == "km"
    assert len(t["times_unix"]) == len(t["positions_km"]) == 181
    assert client.get("/api/objects/NOPE/trajectory", params={"scenario_id": SID}).status_code == 404
    bad = client.get(f"/api/objects/{synthetic.PRIMARY_ID}/trajectory", params={"scenario_id": SID, "start": "garbage"})
    assert bad.status_code == 400


def test_full_workflow_with_approval(client):
    r = client.post("/api/conjunctions/screen", json={"scenario_id": SID})
    assert r.status_code == 200
    scr = r.json()
    assert scr["overall_threat_state"] == "CRITICAL"
    top = scr["conjunctions"][0]
    assert top["secondary_id"] == synthetic.SECONDARY_ID and top["pc"]["covariance_basis"] == "ASSUMED_ILLUSTRATIVE"
    cid = top["conjunction_id"]
    assert client.get(f"/api/conjunctions/{cid}", params={"scenario_id": SID}).json()["threat_state"] == "CRITICAL"

    plan = client.post(f"/api/conjunctions/{cid}/maneuvers", json={"scenario_id": SID, "max_candidates": 3}).json()
    assert len(plan["recommended_ids"]) == 3 and plan["objective"]
    mid = plan["recommended_ids"][0]
    chk = client.post(f"/api/maneuvers/{mid}/secondary-check", json={"scenario_id": SID}).json()
    assert chk["validation_status"] == "PASS"

    run = client.post("/api/agent/analyze", json={"scenario_id": SID, "mode": "deterministic"}).json()
    assert run["provider"] == "deterministic" and run["status"] == "NEEDS_APPROVAL"
    assert run["validation"]["status"] == "VALID"
    assert [t["tool"] for t in run["tool_calls"]][:3] == ["list_conjunctions", "get_conjunction_details", "plan_maneuvers"]
    rec = run["report"]["recommended_maneuver_id"]
    assert rec in plan["recommended_ids"]
    assert run["report"]["threat"]["miss_distance_km"] == round(top["miss_distance_km"], 4)

    appr = client.post("/api/simulation/approve", json={"scenario_id": SID, "maneuver_id": rec})
    assert appr.status_code == 200
    sim = appr.json()["simulation"]
    # DEB-4410 and R/B-3307 are still ahead (tests/test_scenario_b.py dodges all three)
    assert sim["overall_threat_state"] == "CRITICAL" and sim["approved_maneuver_id"] == rec
    assert "No command is sent" in appr.json()["decision"]["note"]

    traj = client.get(f"/api/objects/{synthetic.PRIMARY_ID}/trajectory",
                      params={"scenario_id": SID, "maneuver_id": rec, "step_s": 60}).json()
    assert len(traj["segments"]) == 2 and traj["burn_time"] is not None
    assert traj["segments"][1]["model"] == "NUMERICAL_J2"

    rej = client.post("/api/simulation/reject", json={"scenario_id": SID, "maneuver_id": rec, "reason": "operator"}).json()
    assert rej["simulation"]["approved_maneuver_id"] is None and rej["simulation"]["overall_threat_state"] == "CRITICAL"
    assert len(rej["simulation"]["decisions"]) == 2

    assert client.post("/api/simulation/approve", json={"scenario_id": SID, "maneuver_id": "MV-nope"}).status_code == 404
    weak = next(c for c in plan["candidates"] if c["feasible"] and not c["meets_target"])
    assert client.post("/api/simulation/approve", json={"scenario_id": SID, "maneuver_id": weak["maneuver_id"]}).status_code == 409

    before = client.get("/api/simulation/state", params={"scenario_id": SID}).json()["reset_count"]
    reset = client.post(f"/api/scenarios/{SID}/reset").json()
    assert reset["simulation"]["screening_performed"] is False and reset["simulation"]["reset_count"] == before + 1
    assert client.get(f"/api/conjunctions/{cid}", params={"scenario_id": SID}).status_code == 404


def test_plan_requires_screening(client):
    r = client.post("/api/conjunctions/CJ-x/maneuvers", json={"scenario_id": SID})
    assert r.status_code == 404


def test_real_scenario_is_honest_about_uncertainty(client):
    d = client.get(f"/api/scenarios/{real.SCENARIO_ID}").json()
    assert d["kind"] == "real" and d["object_count"] == 18599 and d["data_source"]["retrieved_at"]
    assert d["screening_shortlist"]["size"] < 600 and d["data_source"]["full_catalog"]
    scr = client.post("/api/conjunctions/screen", json={"scenario_id": real.SCENARIO_ID}).json()
    assert scr["stats"]["complete"]
    for c in scr["conjunctions"]:
        assert c["pc"]["status"] == "UNVERIFIED" and c["threat_state"] in ("MONITORING", "UNVERIFIED")
        assert c["primary_model"] == "SGP4"
    names = [x["name"].strip() for x in scr["co_orbital"]]
    assert any("PROGRESS" in n for n in names)


def test_perception_endpoints(client):
    r = client.get("/api/perception", params={"scenario_id": SID})
    assert r.status_code == 200
    d = r.json()
    assert d["objects"][0]["tier"] == "CRITICAL" and d["objects"][0]["object_id"] in synthetic.CRITICAL_STAGED_IDS
    assert d["counts"]["CRITICAL"] == len(synthetic.CRITICAL_STAGED_IDS) and d["screening_mode"] == "FULL_PHYSICS" and d["tier_rules"]
    assert d["model"]["status"] in ("LOADED", "UNAVAILABLE") and d["disclaimer"]
    assert client.get("/api/perception", params={"scenario_id": SID, "maneuver_id": "MV-nope"}).status_code == 404
    assert client.get("/api/perception", params={"scenario_id": SID, "critical_radius_km": 30, "tracked_radius_km": 25}).status_code == 400
    real_r = client.get("/api/perception", params={"scenario_id": real.SCENARIO_ID})
    assert real_r.status_code == 200
    rd = real_r.json()
    # full catalog: 13 passes inside 25 km (10 objects), none inside the critical radius
    assert rd["complete"] and rd["counts"]["CRITICAL"] == 0 and rd["counts"]["SEMI_CRITICAL"] == 13
    assert all(o["physics"]["pc"]["status"] == "UNVERIFIED" for o in rd["objects"] if o["tier"] == "SEMI_CRITICAL")
    assert client.get("/api/perception/model").status_code == 200
