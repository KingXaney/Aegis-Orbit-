"""Committed burns through the API: approve commits the burn into the primary's trajectory, reject
withdraws it, the clock-aware screening/perception defaults, and the autopilot toggle."""
import numpy as np

from app.physics.time_utils import iso
from app.scenarios import real, synthetic

SID = synthetic.SCENARIO_ID
T0 = synthetic.T0_UNIX


def _screen_plan(client):
    scr = client.post("/api/conjunctions/screen", json={"scenario_id": SID}).json()
    cid = scr["conjunctions"][0]["conjunction_id"]
    plan = client.post(f"/api/conjunctions/{cid}/maneuvers", json={"scenario_id": SID, "max_candidates": 3}).json()
    return cid, plan


def _positions(client, **params):
    t = client.get(f"/api/objects/{synthetic.PRIMARY_ID}/trajectory", params={"scenario_id": SID, "step_s": 120, **params}).json()
    return t, np.array([[np.nan if x is None else x for x in row] for row in t["positions_km"]])


def test_approve_commits_the_burn_into_the_default_trajectory(client):
    cid, plan = _screen_plan(client)
    mid = plan["recommended_ids"][0]
    cand = next(c for c in plan["candidates"] if c["maneuver_id"] == mid)
    before, pos_before = _positions(client)
    assert before["variant"] == "original" and before["burn_times_unix"] == []

    appr = client.post("/api/simulation/approve", json={"scenario_id": SID, "maneuver_id": mid}).json()
    sim = appr["simulation"]
    # the later staged passes are still ahead, so the overall state stays critical
    assert sim["overall_threat_state"] == "CRITICAL" and sim["approved_maneuver_id"] == mid
    assert [m["maneuver_id"] for m in sim["committed_maneuvers"]] == [mid]
    assert sim["committed_maneuvers"][0]["source"] == "human"
    assert sim["burn_times_unix"] == [cand["burn_time_unix"]] and sim["primary_version"] == 1
    assert any(e["kind"] == "COMMITTED" for e in sim["events"])

    default, pos_default = _positions(client)
    assert default["variant"] == "committed" and default["burn_times_unix"] == [cand["burn_time_unix"]]
    assert len(default["segments"]) == 2 and default["segments"][1]["model"] == "NUMERICAL_J2"
    assert default["segments"][1]["maneuver_id"] == mid
    times = np.array(default["times_unix"])
    assert cand["burn_time_unix"] in times  # the kink is sampled
    original, pos_original = _positions(client, variant="original")
    assert original["variant"] == "original" and original["burn_times_unix"] == []
    pre = np.array(original["times_unix"]) < cand["burn_time_unix"]
    common = np.isin(np.array(original["times_unix"]), times)
    assert np.allclose(pos_original[pre & common], pos_default[np.isin(times, np.array(original["times_unix"])[pre])])
    post = np.array(default["times_unix"]) > cand["burn_time_unix"] + 1800
    assert np.nanmax(np.linalg.norm(pos_default[post] - pos_original[np.isin(np.array(original["times_unix"]), times[post])], axis=1)) > 0.5
    via_id, pos_via_id = _positions(client, maneuver_id=mid)
    assert via_id["variant"] == "committed" and np.allclose(pos_via_id, pos_default)

    objs = client.get("/api/objects", params={"scenario_id": SID}).json()["objects"]
    primary = next(o for o in objs if o["object_id"] == synthetic.PRIMARY_ID)
    assert primary["propagation_model"] == "PIECEWISE_J2" and primary["base_model"] == "NUMERICAL_J2"
    assert [b["maneuver_id"] for b in primary["burns"]] == [mid]

    # the screening now sees the committed path: the mitigated pass is no longer critical (the debris's
    # other repeat passes may move too); only the later staged passes remain critical
    cur = client.get("/api/conjunctions", params={"scenario_id": SID}).json()
    mitigated = [c for c in cur["conjunctions"] if c["secondary_id"] == synthetic.SECONDARY_ID
                 and abs(c["tca_unix"] - cand["post_tca_unix"]) < 600.0]
    assert mitigated and abs(mitigated[0]["miss_distance_km"] - cand["post_miss_distance_km"]) < 0.1
    assert {c["secondary_id"] for c in cur["conjunctions"] if c["threat_state"] == "CRITICAL"} == set(synthetic.CRITICAL_STAGED_IDS[1:])
    assert all(c["threat_state"] in ("MONITORING", "NORMAL") for c in cur["conjunctions"] if c["secondary_id"] not in synthetic.CRITICAL_STAGED_IDS[1:])

    # approving the same burn twice, or a second burn earlier than the committed one, is refused
    assert client.post("/api/simulation/approve", json={"scenario_id": SID, "maneuver_id": mid}).status_code == 409


def test_approve_records_the_avoided_pass_and_serves_the_before_burn_path(client):
    cid, plan = _screen_plan(client)
    conj = next(c for c in client.get("/api/conjunctions", params={"scenario_id": SID}).json()["conjunctions"] if c["conjunction_id"] == cid)
    mid = plan["recommended_ids"][0]
    cand = next(c for c in plan["candidates"] if c["maneuver_id"] == mid)
    before, pos_before = _positions(client)
    traj_url = f"/api/objects/{synthetic.PRIMARY_ID}/trajectory"
    base = {"scenario_id": SID, "variant": "before_burn"}
    # a candidate that is not committed has no before-burn path yet
    assert client.get(traj_url, params={**base, "maneuver_id": mid}).status_code == 400

    sim = client.post("/api/simulation/approve", json={"scenario_id": SID, "maneuver_id": mid}).json()["simulation"]
    ap = sim["committed_maneuvers"][0]["avoided_pass"]
    assert ap["conjunction_id"] == cid and ap["secondary_id"] == synthetic.SECONDARY_ID and ap["secondary_name"]
    assert ap["basis"] == "screening" and ap["threat_state"] == "CRITICAL"
    assert abs(ap["tca_unix"] - (cand["burn_time_unix"] + cand["lead_time_s"])) < 1e-6
    assert abs(ap["tca_unix"] - conj["tca_unix"]) < 1.0 and ap["tca"] == iso(ap["tca_unix"])
    assert abs(ap["miss_km"] - cand["screening_miss_distance_km"]) < 1e-9
    assert len(ap["ghost_r_km"]) == 3 and len(ap["secondary_r_km"]) == 3 and ap["relative_speed_kms"] > 1.0

    # the ghost's course is the primary without this burn: the pre-approval path
    ghost, pos_ghost = _positions(client, variant="before_burn", maneuver_id=mid)
    assert ghost["variant"] == "before_burn" and ghost["burn_times_unix"] == [] and ghost["maneuver_id"] == mid
    assert ghost["times_unix"] == before["times_unix"] and np.allclose(pos_ghost, pos_before)
    # at the avoided pass the ghost and the debris are the recorded miss apart
    window = {"start": iso(ap["tca_unix"]), "end": iso(ap["tca_unix"] + 1.0), "step_s": 1}
    at = client.get(traj_url, params={**base, "maneuver_id": mid, **window}).json()
    deb = client.get(f"/api/objects/{synthetic.SECONDARY_ID}/trajectory", params={"scenario_id": SID, **window}).json()
    gap = float(np.linalg.norm(np.array(at["positions_km"][0]) - np.array(deb["positions_km"][0])))
    assert abs(gap - ap["miss_km"]) < 0.05

    # the variant needs the maneuver id of a committed burn of the primary
    assert client.get(traj_url, params=base).status_code == 400
    assert client.get(traj_url, params={**base, "maneuver_id": "MV-nope"}).status_code == 404
    assert client.get(f"/api/objects/{synthetic.SECONDARY_ID}/trajectory", params={**base, "maneuver_id": mid}).status_code == 400
    client.post("/api/simulation/reject", json={"scenario_id": SID, "maneuver_id": mid, "reason": "operator"})
    assert client.get(traj_url, params={**base, "maneuver_id": mid}).status_code == 400


def test_reject_withdraws_the_committed_burn(client):
    cid, plan = _screen_plan(client)
    mid = plan["recommended_ids"][0]
    client.post("/api/simulation/approve", json={"scenario_id": SID, "maneuver_id": mid})
    rej = client.post("/api/simulation/reject", json={"scenario_id": SID, "maneuver_id": mid, "reason": "operator"}).json()
    sim = rej["simulation"]
    assert sim["approved_maneuver_id"] is None and sim["committed_maneuvers"] == [] and sim["burn_times_unix"] == []
    assert sim["overall_threat_state"] == "CRITICAL" and sim["primary_version"] == 2
    assert [e["kind"] for e in sim["events"]][-1] == "UNCOMMITTED"
    t, _ = _positions(client)
    assert t["variant"] == "original" and len(t["segments"]) == 1
    objs = client.get("/api/objects", params={"scenario_id": SID}).json()["objects"]
    primary = next(o for o in objs if o["object_id"] == synthetic.PRIMARY_ID)
    assert primary["propagation_model"] == "NUMERICAL_J2" and primary["burns"] == []


def test_autopilot_toggle_and_sandbox_flag(client):
    sandbox_id = synthetic.SANDBOX_SCENARIO_ID
    assert [s["scenario_id"] for s in client.get("/api/scenarios").json()] == [SID, real.SCENARIO_ID, sandbox_id]
    d = client.get(f"/api/scenarios/{sandbox_id}").json()
    assert d["kind"] == "sandbox" and d["sandbox"] is True
    assert d["simulation"]["autopilot"] is True and d["simulation"]["sandbox"] is True
    assert d["object_count"] == 6 and synthetic.SECONDARY_ID not in d["rendered_object_ids"]
    r = client.post("/api/simulation/autopilot", json={"scenario_id": sandbox_id, "enabled": False})
    assert r.status_code == 200 and r.json()["autopilot"] is False
    assert client.get("/api/simulation/state", params={"scenario_id": sandbox_id}).json()["autopilot"] is False
    for other in (SID, real.SCENARIO_ID):
        od = client.get(f"/api/scenarios/{other}").json()
        assert od["sandbox"] is False and od["simulation"]["autopilot"] is False
        assert client.post("/api/simulation/autopilot", json={"scenario_id": other, "enabled": True}).status_code == 409


def test_screen_with_start_only_uses_the_window_span_and_sets_the_clock(client):
    start = T0 + 3600.0
    scr = client.post("/api/conjunctions/screen", json={"scenario_id": SID, "start": iso(start)}).json()
    assert scr["stats"]["window"] == {"start": iso(start), "end": iso(start + 6 * 3600.0)}
    assert scr["conjunctions"][0]["secondary_id"] == synthetic.SECONDARY_ID
    state = client.get("/api/simulation/state", params={"scenario_id": SID}).json()
    assert state["clock"] == iso(start)
    # a trajectory requested from a start without an end also spans the window length
    t = client.get(f"/api/objects/{synthetic.PRIMARY_ID}/trajectory",
                   params={"scenario_id": SID, "start": iso(start), "step_s": 600}).json()
    assert t["start"] == iso(start) and t["end"] == iso(start + 6 * 3600.0)


def test_perception_measures_from_the_requested_start(client):
    start = T0 + 3600.0
    d = client.get("/api/perception", params={"scenario_id": SID, "start": iso(start)}).json()
    assert d["horizon"]["start"] == iso(start)
    crit = next(o for o in d["objects"] if o["tier"] == "CRITICAL")
    assert abs(crit["physics"]["time_to_tca_s"] - (crit["physics"]["tca_unix"] - start)) < 1e-3
    assert abs(crit["physics"]["tca_unix"] - (T0 + synthetic.TCA_OFFSET_S)) < 0.1
    again = client.get("/api/perception", params={"scenario_id": SID, "start": iso(start)}).json()
    assert again["cached"] is True
    later = client.get("/api/perception", params={"scenario_id": SID, "start": iso(start + 600.0)}).json()
    assert later["cached"] is False and later["horizon"]["start"] == iso(start + 600.0)
