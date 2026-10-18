"""Scenario B's run of encounters, dodged one by one the way the operator flow does it."""
from app.scenarios import registry, synthetic
from app.simulation import service
from app.simulation.session import SimulationSession


def _session() -> SimulationSession:
    return SimulationSession(registry.build_synthetic())


def _critical_ahead(sess: SimulationSession, after: float):
    cur = service.current_screening(sess)["conjunctions"]
    return sorted((c for c in cur if c["threat_state"] == "CRITICAL" and c["tca_unix"] > after), key=lambda c: c["tca_unix"])


def test_screening_detects_every_staged_pass_and_flags_three_critical():
    scr = service.run_screening(_session())
    detected = {c["secondary_id"] for c in scr["conjunctions"]}
    assert {p.object_id for p in synthetic.STAGED_PASSES} <= detected
    critical = {c["secondary_id"] for c in scr["conjunctions"] if c["threat_state"] == "CRITICAL"}
    assert critical == set(synthetic.CRITICAL_STAGED_IDS)
    # the 12 km pass is detected but only monitored
    safe = [c for c in scr["conjunctions"] if c["secondary_id"] == "SYN-DEB-1188"]
    assert safe and all(c["threat_state"] == "MONITORING" for c in safe)
    assert min(c["miss_distance_km"] for c in safe) > 10.0


def test_operator_flow_dodges_each_critical_pass_in_time_order():
    sess = _session()
    service.run_screening(sess)
    dodged, last_burn = [], float("-inf")
    for _ in synthetic.CRITICAL_STAGED_IDS:
        top = service.current_screening(sess)["conjunctions"][0]  # where the UI and the agent start
        # screening ranks by miss distance; the scenario is designed so that this is also the next pass in time
        assert top["conjunction_id"] == _critical_ahead(sess, last_burn)[0]["conjunction_id"]
        plan = service.plan_for_conjunction(sess, top["conjunction_id"])
        res = service.commit(sess, plan["recommended_ids"][0])
        assert res["secondary_check"]["validation_status"] == "PASS"
        assert res["maneuver"]["burn_time_unix"] > last_burn and res["maneuver"]["meets_target"]
        last_burn = res["maneuver"]["burn_time_unix"]
        dodged.append(top["secondary_id"])
    assert dodged == list(synthetic.CRITICAL_STAGED_IDS)
    assert _critical_ahead(sess, float("-inf")) == []
    assert sess.overall_threat_state() == "MITIGATED"
