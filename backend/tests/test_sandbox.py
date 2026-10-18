"""The live sandbox: spawning junk around the primary, the autopilot's evaluate loop, and the API."""
import numpy as np
import pytest

from app.physics.screening import screen
from app.physics.threat import ORDER
from app.physics.time_utils import iso
from app.scenarios import real, synthetic
from app.simulation import sandbox, service
from app.simulation.sandbox import JUNK_TYPES, SpawnSpec
from app.simulation.session import SessionStore

SID = synthetic.SANDBOX_SCENARIO_ID
T0 = synthetic.T0_UNIX
NOW = T0 + 600.0


@pytest.fixture()
def session():
    return SessionStore().get(SID)


def _period(session):
    return session.scenario.catalog.require(synthetic.PRIMARY_ID).period_s


def test_construct_encounter_reproduces_the_designed_pass_for_every_kind(session):
    primary = session.scenario.catalog.require(synthetic.PRIMARY_ID)
    for kind, jt in JUNK_TYPES.items():
        tca = NOW + 2400.0
        miss_h, miss_r = 0.6 * jt.miss_band_km[1], 0.1 * jt.miss_band_km[1]
        crossing = 0.5 * (jt.crossing_deg[0] + jt.crossing_deg[1])
        r_now, v_now, designed = sandbox.construct_encounter(primary, NOW, tca, miss_h, miss_r, crossing, jt.speed_factor[0])
        obj = sandbox.make_junk_object(session, kind, r_now, v_now, NOW, designed, seed=1)
        assert obj.design.design_id == jt.design.design_id and obj.spawned_at_unix == NOW
        assert obj.category == jt.category and obj.covariance_source == "ASSUMED_ILLUSTRATIVE"
        res = screen(primary, [obj], NOW, NOW + 3600.0)
        assert res.conjunctions, kind
        c = res.conjunctions[0]
        assert abs(c.tca_unix - tca) < 1.0, kind
        assert abs(c.miss_distance_km - np.hypot(miss_h, miss_r)) < 0.01, kind
        assert abs(c.relative_speed_kms - designed["relative_speed_kms"]) < 0.05, kind
    with pytest.raises(ValueError):
        sandbox.construct_encounter(primary, NOW, NOW + 100.0, 1.0, 0.0, 30.0)
    with pytest.raises(ValueError):
        sandbox.construct_encounter(primary, NOW, NOW + 2400.0, 1.0, 0.0, 0.1)


def test_spawn_adds_a_catalog_object_and_an_event(session):
    res = sandbox.spawn(session, NOW, SpawnSpec(kind="rocket_body", time_to_tca_s=3000.0, seed=3))
    obj = res["object"]
    jt = JUNK_TYPES["rocket_body"]
    assert obj["object_id"].startswith("SBX-RB-") and obj["spawned_at_unix"] == NOW and obj["spawned_at"] == iso(NOW)
    assert obj["spawn"]["kind"] == "rocket_body" and jt.miss_band_km[0] <= res["designed"]["miss_km"] <= jt.miss_band_km[1]
    assert res["designed"]["tca_unix"] == NOW + 3000.0 and res["designed"]["band_km"] == list(jt.miss_band_km)
    assert obj["design"]["design_id"] == "rocket-body" and obj["propagation_model"] == "NUMERICAL_J2"
    assert obj["object_id"] in session.scenario.catalog and session.spawned_ids == [obj["object_id"]]
    assert obj["object_id"] in session.scenario.rendered_object_ids
    assert res["events"][0]["kind"] == "SPAWNED" and res["simulation"]["clock"] == iso(NOW)
    assert res["simulation"]["spawned_object_ids"] == [obj["object_id"]]
    # the spawned object is part of the next screening from now
    scr = service.run_screening(session, start=iso(NOW))
    hit = [c for c in scr["conjunctions"] if c["secondary_id"] == obj["object_id"]]
    assert hit and abs(hit[0]["tca_unix"] - (NOW + 3000.0)) < 1.0
    # its trajectory omits samples before the spawn
    t = service.trajectory(session, obj["object_id"], start=iso(NOW - 600.0), end=iso(NOW + 600.0), step_s=60.0)
    assert t["positions_km"][0][0] is None and t["positions_km"][-1][0] is not None


def test_spawn_validation_and_cap(session):
    with pytest.raises(service.BadRequest):
        sandbox.spawn(session, NOW, SpawnSpec(kind="banana"))
    with pytest.raises(service.BadRequest):
        sandbox.spawn(session, NOW, SpawnSpec(kind="fragment", time_to_tca_s=60.0))
    real_sess = SessionStore().get(real.SCENARIO_ID)
    with pytest.raises(service.Conflict):
        sandbox.spawn(real_sess, real_sess.scenario.start_unix, SpawnSpec(kind="fragment"))
    with pytest.raises(service.Conflict):
        sandbox.evaluate(real_sess, real_sess.scenario.start_unix)


def test_spawn_random_is_seeded_and_inside_the_bands(session):
    period = _period(session)
    res = sandbox.spawn_random(session, NOW, count=6, seed=7)
    assert len(res["objects"]) == 6 and res["seed"] == 7
    for o, d in zip(res["objects"], res["designed"]):
        jt = JUNK_TYPES[o["spawn"]["kind"]]
        assert jt.miss_band_km[0] <= d["miss_km"] <= jt.miss_band_km[1]
        assert NOW + 1800.0 <= d["tca_unix"] <= NOW + 2.0 * period
        assert o["spawned_at_unix"] == NOW
    ids = [o["object_id"] for o in res["objects"]]
    assert len(set(ids)) == 6 and session.spawned_ids == ids
    same = sandbox.spawn_random(SessionStore().get(SID), NOW, count=6, seed=7)
    assert [d["tca_unix"] for d in same["designed"]] == [d["tca_unix"] for d in res["designed"]]
    assert [d["miss_km"] for d in same["designed"]] == [d["miss_km"] for d in res["designed"]]
    other = sandbox.spawn_random(SessionStore().get(SID), NOW, count=6, seed=8)
    assert [d["tca_unix"] for d in other["designed"]] != [d["tca_unix"] for d in res["designed"]]


def test_drop_point_picks_the_pass_over_that_spot(session):
    primary = session.scenario.catalog.require(synthetic.PRIMARY_ID)
    t = sandbox.time_of_closest_pass(primary, NOW, 10.0, 20.0, 2.0 * _period(session))
    assert NOW + 180.0 <= t <= NOW + 2.0 * _period(session)
    res = sandbox.spawn(session, NOW, SpawnSpec(kind="fragment", drop_point=(10.0, 20.0), seed=2))
    assert abs(res["designed"]["tca_unix"] - t) < 1e-6


def test_sandbox_profile_recommends_only_burns_that_clear_the_distance(session):
    sp = sandbox.spawn(session, NOW, SpawnSpec(kind="fragment", time_to_tca_s=2400.0, offset_km=0.4, seed=1))
    scr = service.run_screening(session, start=iso(NOW))
    cid = next(c["conjunction_id"] for c in scr["conjunctions"] if c["secondary_id"] == sp["object"]["object_id"])
    plan = service.plan_for_conjunction(session, cid, max_candidates=3)
    assert plan["config"]["profile"] == "sandbox" and plan["config"]["require_distance_target"] is True
    rec = [c for c in plan["candidates"] if c["maneuver_id"] in plan["recommended_ids"]]
    assert rec and all(c["meets_target"] and c["post_miss_distance_km"] >= 5.0 for c in rec)


def test_evaluate_commits_a_burn_and_the_pass_clears(session):
    period = _period(session)
    sp = sandbox.spawn(session, NOW, SpawnSpec(kind="fragment", time_to_tca_s=2400.0, offset_km=0.4, seed=1))
    jid = sp["object"]["object_id"]
    res = sandbox.evaluate(session, NOW)
    assert res["cached"] is False and res["screening"]["start"] == iso(NOW)
    mine = [a for a in res["actions"] if a["secondary_id"] == jid]
    assert mine and mine[0]["outcome"] == "COMMITTED" and mine[0]["maneuver_id"]
    assert session.committed and session.committed[0].source == "autopilot"
    assert any(e["kind"] == "COMMITTED" for e in res["events_added"])
    burn = session.committed[0]
    assert NOW + 30.0 <= burn.burn_time_unix < NOW + 2400.0 - 300.0
    assert res["simulation"]["committed_maneuvers"][0]["source"] == "autopilot"
    ap = res["simulation"]["committed_maneuvers"][0]["avoided_pass"]
    assert ap["secondary_id"] == jid and abs(ap["tca_unix"] - (NOW + 2400.0)) < 2.0 and abs(ap["miss_km"] - 0.4) < 0.05
    # the same evaluation again within the interval is served from the cache
    again = sandbox.evaluate(session, NOW + 1.0)
    assert again["cached"] is True
    # later, after the burn fired: the junk passes at least the target distance away
    later = sandbox.evaluate(session, NOW + 1800.0)
    assert later["cached"] is False
    hit = [c for c in later["conjunctions"] if c["secondary_id"] == jid]
    assert hit and hit[0]["miss_distance_km"] >= 5.0 and ORDER.index(hit[0]["threat_state"]) <= ORDER.index("MONITORING")
    assert [a["outcome"] for a in later["actions"] if a["secondary_id"] == jid] in ([], ["MITIGATED"])
    assert later["simulation"]["committed_maneuvers"][0]["fired"] is True
    # removing the junk keeps the burn, avoided pass included (the frontend drops the ghost itself)
    out = sandbox.remove(session, NOW + 1900.0, object_ids=[jid])
    assert out["removed"] == [jid] and out["simulation"]["committed_maneuvers"][0]["avoided_pass"]["secondary_id"] == jid


def test_sequential_spawns_commit_burns_in_time_order(session):
    period = _period(session)
    sandbox.spawn(session, NOW, SpawnSpec(kind="fragment", time_to_tca_s=2400.0, offset_km=0.4, seed=1))
    sandbox.evaluate(session, NOW)
    n_first = len(session.committed)
    assert n_first >= 1
    now2 = NOW + 900.0
    sp = sandbox.spawn(session, now2, SpawnSpec(kind="fragment", time_to_tca_s=1.8 * period, offset_km=0.3, seed=2))
    res = sandbox.evaluate(session, now2)
    mine = [a for a in res["actions"] if a["secondary_id"] == sp["object"]["object_id"]]
    assert mine and mine[0]["outcome"] == "COMMITTED"
    times = [b.burn_time_unix for b in session.committed]
    assert len(times) == n_first + 1 and times == sorted(times) and len(set(times)) == len(times)
    primary = session.scenario.catalog.require(synthetic.PRIMARY_ID)
    assert len(primary.segments) == len(session.committed)
    # the second ghost flies the course with the first burn but without the second
    second = session.committed[-1]
    assert second.avoided_pass["secondary_id"] == sp["object"]["object_id"]
    ghost = service.trajectory(session, synthetic.PRIMARY_ID, iso(now2), iso(now2 + 2 * period), 60.0,
                               maneuver_id=second.maneuver_id, variant="before_burn")
    assert ghost["variant"] == "before_burn" and ghost["burn_times_unix"] == times[:-1]


def test_autopilot_off_waits_for_approval(session):
    service.set_autopilot(session, False)
    sp = sandbox.spawn(session, NOW, SpawnSpec(kind="fragment", time_to_tca_s=2400.0, offset_km=0.4, seed=1))
    res = sandbox.evaluate(session, NOW)
    mine = [a for a in res["actions"] if a["secondary_id"] == sp["object"]["object_id"]]
    assert mine and mine[0]["outcome"] == "AWAITING_APPROVAL" and mine[0]["maneuver_id"]
    assert session.committed == []
    appr = service.approve(session, mine[0]["maneuver_id"])
    assert appr["simulation"]["committed_maneuvers"][0]["source"] == "human"
    assert len(session.committed) == 1


def test_sandbox_starts_with_an_empty_sky(session):
    assert synthetic.SECONDARY_ID not in session.scenario.catalog
    assert session.scenario.kind == "sandbox" and session.sandbox and session.autopilot
    scr = service.run_screening(session, start=iso(NOW))
    assert scr["conjunctions"] == [] and scr["overall_threat_state"] == "NORMAL"
    res = sandbox.evaluate(session, NOW)
    assert res["actions"] == [] and res["simulation"]["committed_maneuvers"] == []
    scripted = SessionStore().get(synthetic.SCENARIO_ID)
    assert not scripted.sandbox and not scripted.autopilot
    with pytest.raises(service.Conflict):
        sandbox.spawn(scripted, NOW, SpawnSpec(kind="fragment"))


def test_too_late_is_reported_as_unavoidable(session):
    sp = sandbox.spawn(session, NOW, SpawnSpec(kind="fragment", time_to_tca_s=300.0, offset_km=0.4, seed=1))
    res = sandbox.evaluate(session, NOW)
    mine = [a for a in res["actions"] if a["secondary_id"] == sp["object"]["object_id"]]
    assert mine and mine[0]["outcome"] == "UNAVOIDABLE" and "late" in mine[0]["reason"].lower()
    assert any(e["kind"] == "UNAVOIDABLE" for e in res["events_added"])


def test_remove_takes_junk_out_of_the_catalog_and_the_screening(session):
    res = sandbox.spawn_random(session, NOW, count=3, seed=5)
    ids = [o["object_id"] for o in res["objects"]]
    service.run_screening(session, start=iso(NOW))
    assert any(c.secondary_id in ids for c in session.conjunctions.values())
    out = sandbox.remove(session, NOW + 60.0, count=2)
    assert out["removed"] == ids[-2:] and session.spawned_ids == ids[:1]
    for oid in ids[-2:]:
        assert oid not in session.scenario.catalog and oid not in session.scenario.rendered_object_ids
    assert all(c.secondary_id not in ids[-2:] for c in session.conjunctions.values())
    assert out["events"][0]["kind"] == "REMOVED" and out["simulation"]["spawned_object_ids"] == ids[:1]
    by_id = sandbox.remove(session, NOW + 120.0, object_ids=ids[:1])
    assert by_id["removed"] == ids[:1] and session.spawned_ids == []
    with pytest.raises(service.NotFound):
        sandbox.remove(session, NOW + 130.0, object_ids=["SBX-FRAG-999"])
    assert sandbox.remove(session, NOW + 140.0, count=3)["removed"] == []


def test_sandbox_api(client):
    now = iso(NOW)
    r = client.post("/api/sandbox/spawn", json={"scenario_id": SID, "now": now, "kind": "fragment", "time_to_tca_s": 2400, "seed": 1})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["object"]["object_id"].startswith("SBX-FRAG-") and 0.1 <= d["designed"]["miss_km"] <= 3.0
    objs = client.get("/api/objects", params={"scenario_id": SID}).json()["objects"]
    assert any(o["object_id"] == d["object"]["object_id"] and o["spawned_at"] == now for o in objs)
    kinds = client.get("/api/sandbox/junk-types").json()
    assert {k["kind"] for k in kinds["kinds"]} == {"fragment", "rocket_body", "dead_satellite"}
    rb = client.post("/api/sandbox/spawn_random", json={"scenario_id": SID, "now": now, "count": 3, "seed": 4}).json()
    assert len(rb["objects"]) == 3 and rb["simulation"]["spawned_object_ids"][0] == d["object"]["object_id"]
    # the batch endpoint serves spawned objects from before their spawn time with null samples (a page reload)
    batch = client.post("/api/objects/trajectories", json={"scenario_id": SID, "object_ids": [synthetic.PRIMARY_ID, d["object"]["object_id"]],
                                                           "step_s": 300, "start": iso(T0), "end": iso(NOW + 1200)})
    assert batch.status_code == 200, batch.text
    spawned_t = batch.json()["trajectories"][1]
    assert spawned_t["positions_km"][0] == [None, None, None] and spawned_t["positions_km"][-1][0] is not None
    assert any("spawn time" in m for m in spawned_t["messages"])
    ev = client.post("/api/sandbox/evaluate", json={"scenario_id": SID, "now": now, "earliest_burn_after_s": 60}).json()
    assert ev["cached"] is False and ev["actions"] and ev["simulation"]["clock"] == now
    assert client.post("/api/sandbox/spawn", json={"scenario_id": SID, "now": now, "kind": "banana"}).status_code == 400
    assert client.post("/api/sandbox/spawn", json={"scenario_id": real.SCENARIO_ID, "now": now, "kind": "fragment"}).status_code == 409
    assert client.post("/api/sandbox/evaluate", json={"scenario_id": real.SCENARIO_ID, "now": now}).status_code == 409
    assert client.post("/api/sandbox/spawn", json={"scenario_id": SID, "now": "garbage", "kind": "fragment"}).status_code == 400
    rm = client.post("/api/sandbox/remove", json={"scenario_id": SID, "now": now, "count": 2})
    assert rm.status_code == 200 and len(rm.json()["removed"]) == 2 and len(rm.json()["simulation"]["spawned_object_ids"]) == 2
    assert client.post("/api/sandbox/remove", json={"scenario_id": SID, "now": now, "object_ids": ["nope"]}).status_code == 404
    assert client.post("/api/sandbox/remove", json={"scenario_id": real.SCENARIO_ID, "now": now, "count": 1}).status_code == 409
