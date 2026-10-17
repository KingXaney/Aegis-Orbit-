from app.agent import orchestrator
from app.agent.gemini_client import ModelTurn
from app.agent.tools import function_declarations
from app.scenarios import synthetic
from app.simulation.session import SessionStore


def _session():
    return SessionStore().get(synthetic.SCENARIO_ID)


def test_deterministic_run_is_valid_and_logged():
    sess = _session()
    run = orchestrator.run_analysis(sess, mode="deterministic")
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
    orchestrator.run_analysis(sess, mode="deterministic")
    report = dict(sess.agent_runs[-1]["report"])
    report["recommended_maneuver_id"] = "MV-does-not-exist"
    v = orchestrator.validate_report(sess, report, sess.agent_runs[-1]["tool_calls"])
    assert v["status"] == "INVALID"
    assert any(c["check"] == "maneuver_exists" and not c["ok"] for c in v["checks"])


class FakeGemini:
    """Scripted stand-in for the Gemini client following the prescribed workflow."""

    def __init__(self, *args, **kwargs):
        self.turns = 0
        self.last_results = None
        self.plan_ids = []
        self.cid = None

    def start(self, prompt):
        return ModelTurn(text=None, function_calls=[{"name": "list_conjunctions", "args": {}}])

    def send_tool_results(self, results):
        self.last_results = results
        name = results[0]["name"]
        resp = results[0]["response"]
        if name == "list_conjunctions":
            self.cid = resp["conjunctions"][0]["conjunction_id"]
            return ModelTurn(None, [{"name": "get_conjunction_details", "args": {"conjunction_id": self.cid}}])
        if name == "get_conjunction_details":
            return ModelTurn(None, [{"name": "plan_maneuvers", "args": {"conjunction_id": self.cid, "max_candidates": 2}}])
        if name == "plan_maneuvers":
            self.plan_ids = [m["maneuver_id"] for m in resp["recommended_candidates"]]
            return ModelTurn(None, [{"name": "check_secondary", "args": {"maneuver_id": m}} for m in self.plan_ids])
        if name == "check_secondary":
            return ModelTurn(None, [{"name": "generate_report", "args": {
                "threat_conjunction_id": self.cid, "recommended_maneuver_id": self.plan_ids[0],
                "threat_summary": "t", "risk_assessment": "r", "maneuver_comparison": "m", "secondary_risks": "s",
                "recommendation_rationale": "why", "uncertainties": "u"}}])
        return ModelTurn("done", [])


def test_gemini_loop_with_scripted_model(monkeypatch):
    import app.agent.gemini_client as gc
    monkeypatch.setattr(gc, "GeminiClient", FakeGemini)
    monkeypatch.setattr(orchestrator.get_settings(), "gemini_api_key", "fake-key")
    sess = _session()
    run = orchestrator.run_analysis(sess, mode="gemini")
    assert run["provider"] == "gemini" and run["status"] == "NEEDS_APPROVAL"
    assert run["validation"]["status"] == "VALID"
    assert run["report"]["recommended_maneuver_id"] in sess.maneuvers
    assert run["tool_calls"][-1]["tool"] == "generate_report"


def test_function_declarations_are_well_formed():
    decls = function_declarations()
    assert {d["name"] for d in decls} == {"list_conjunctions", "get_conjunction_details", "plan_maneuvers",
                                           "check_secondary", "generate_report"}
    for d in decls:
        assert d["parameters"]["type"] == "object" and d["description"]
