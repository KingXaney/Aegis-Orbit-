from app.agent import orchestrator
from app.scenarios import synthetic
from app.simulation.session import SessionStore


def _session():
    return SessionStore().get(synthetic.SCENARIO_ID)


def test_run_is_valid_and_logged():
    sess = _session()
    run = orchestrator.run_analysis(sess)
    assert run["provider"] == "deterministic"
    assert run["status"] == "NEEDS_APPROVAL" and run["validation"]["status"] == "VALID"
    tools = [t["tool"] for t in run["tool_calls"]]
    assert tools[:3] == ["list_conjunctions", "get_conjunction_details", "plan_maneuvers"]
    assert tools.count("check_secondary") == 3 and tools[-1] == "generate_report"
    assert all(t["status"] == "OK" and t["duration_ms"] >= 0 for t in run["tool_calls"])
    rep = run["report"]
    assert rep["recommended_maneuver_id"] in sess.maneuvers and rep["awaiting_human_decision"]
    assert "awaiting human approval" in run["narrative"]
    assert sess.agent_runs[-1]["run_id"] == run["run_id"]


def test_validation_rejects_unknown_maneuver():
    sess = _session()
    orchestrator.run_analysis(sess)
    report = dict(sess.agent_runs[-1]["report"])
    report["recommended_maneuver_id"] = "MV-does-not-exist"
    v = orchestrator.validate_report(sess, report, sess.agent_runs[-1]["tool_calls"])
    assert v["status"] == "INVALID"
    assert any(c["check"] == "maneuver_exists" and not c["ok"] for c in v["checks"])


def test_a_tool_failure_still_returns_a_run_record():
    sess = _session()
    run = orchestrator.run_analysis(sess, conjunction_id="CJ-does-not-exist")
    assert run["status"] == "FAILED"
    assert any("agent run failed" in w for w in run["warnings"])
    assert sess.agent_runs[-1]["run_id"] == run["run_id"]
