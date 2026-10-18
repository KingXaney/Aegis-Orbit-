import pytest

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


def test_gemini_is_the_default_and_falls_back_without_a_key(monkeypatch):
    from app.config import Settings
    # auto picks Gemini when a key is set and keeps the deterministic fallback
    assert Settings.model_fields["agent_mode"].default == "auto"
    s = orchestrator.get_settings()
    monkeypatch.setattr(s, "agent_mode", "auto")
    monkeypatch.setattr(s, "gemini_api_key", "fake-key")
    assert orchestrator._select_provider(None) == ("gemini", [])
    assert orchestrator._select_provider("deterministic") == ("deterministic", [])
    monkeypatch.setattr(s, "gemini_api_key", None)
    provider, warnings = orchestrator._select_provider(None)
    assert provider == "deterministic" and "GEMINI_API_KEY" in warnings[0]


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


# --------------------------------------------------------------------------
# resilience: transient errors are retried, unavailable models are skipped,
# and in auto mode the deterministic agent is the last resort
# --------------------------------------------------------------------------

def _api_error(code, status, message, retry_delay=None):
    from google.genai import errors
    body = {"error": {"code": code, "message": message, "status": status, "details": []}}
    if retry_delay is not None:
        body["error"]["details"].append({"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": retry_delay})
    return (errors.ServerError if code >= 500 else errors.ClientError)(code, body)


def _text_response(text):
    from types import SimpleNamespace
    from google.genai import types
    content = types.Content(role="model", parts=[types.Part.from_text(text=text)])
    return SimpleNamespace(candidates=[SimpleNamespace(content=content)])


def _client(monkeypatch, outcomes, sleeps):
    from app.agent.gemini_client import GeminiClient
    client = GeminiClient(api_key="fake-key", model="m-test", system_instruction="s", declarations=function_declarations(),
                          attempts=2, base_delay_s=2.0, sleep=sleeps.append)
    calls = iter(outcomes)

    def generate_content(**kwargs):
        out = next(calls)
        if isinstance(out, Exception):
            raise out
        return out

    monkeypatch.setattr(client._client.models, "generate_content", generate_content)
    return client


def test_gemini_client_retries_a_503_with_backoff(monkeypatch):
    sleeps = []
    client = _client(monkeypatch, [_api_error(503, "UNAVAILABLE", "high demand"), _text_response("OK")], sleeps)
    assert client.start("hi").text == "OK"
    assert sleeps == [2.0]


def test_gemini_client_gives_up_after_the_retry_budget(monkeypatch):
    from app.agent.gemini_client import GeminiUnavailable
    sleeps = []
    client = _client(monkeypatch, [_api_error(503, "UNAVAILABLE", "high demand")] * 3, sleeps)
    with pytest.raises(GeminiUnavailable) as info:
        client.start("hi")
    assert info.value.code == 503 and info.value.model == "m-test" and "high demand" in info.value.reason
    assert sleeps == [2.0, 4.0]


def test_gemini_client_treats_a_daily_quota_as_unavailable_but_waits_for_a_short_one(monkeypatch):
    from app.agent.gemini_client import GeminiUnavailable
    sleeps = []
    client = _client(monkeypatch, [_api_error(429, "RESOURCE_EXHAUSTED", "quota", retry_delay="33640s")], sleeps)
    with pytest.raises(GeminiUnavailable) as info:
        client.start("hi")
    assert info.value.code == 429 and sleeps == []
    sleeps = []
    client = _client(monkeypatch, [_api_error(429, "RESOURCE_EXHAUSTED", "quota", retry_delay="3s"), _text_response("OK")], sleeps)
    assert client.start("hi").text == "OK"
    assert sleeps == [3.0]


class FlakyGemini(FakeGemini):
    """Scripted client whose named models are unavailable from the first call."""

    unavailable = set()

    def __init__(self, *args, **kwargs):
        super().__init__()
        self.model = kwargs.get("model")

    def start(self, prompt):
        if self.model in self.unavailable:
            from app.agent.gemini_client import GeminiUnavailable
            raise GeminiUnavailable(self.model, 429, "429 RESOURCE_EXHAUSTED: daily quota")
        return super().start(prompt)


def _gemini_settings(monkeypatch, unavailable):
    import app.agent.gemini_client as gc
    monkeypatch.setattr(FlakyGemini, "unavailable", set(unavailable))
    monkeypatch.setattr(gc, "GeminiClient", FlakyGemini)
    s = orchestrator.get_settings()
    monkeypatch.setattr(s, "gemini_api_key", "fake-key")
    monkeypatch.setattr(s, "gemini_model", "gemini-3.8-flash")
    monkeypatch.setattr(s, "gemini_fallback_models", "gemini-3-flash-preview, gemini-3.8-flash")


def test_run_analysis_moves_to_the_next_model_when_the_first_is_unavailable(monkeypatch):
    _gemini_settings(monkeypatch, ["gemini-3.8-flash"])
    assert orchestrator.get_settings().gemini_model_chain == ["gemini-3.8-flash", "gemini-3-flash-preview"]
    run = orchestrator.run_analysis(_session(), mode="auto")
    assert run["provider"] == "gemini" and run["model"] == "gemini-3-flash-preview"
    assert run["status"] == "NEEDS_APPROVAL" and run["validation"]["status"] == "VALID"
    assert any("gemini-3.8-flash" in w and "quota" in w for w in run["warnings"])


def test_run_analysis_falls_back_to_the_deterministic_agent_in_auto_mode(monkeypatch):
    _gemini_settings(monkeypatch, ["gemini-3.8-flash", "gemini-3-flash-preview"])
    run = orchestrator.run_analysis(_session(), mode="auto")
    assert run["provider"] == "deterministic" and run["model"] is None
    assert run["status"] == "NEEDS_APPROVAL" and run["report"]["recommended_maneuver_id"]
    assert any("deterministic" in w for w in run["warnings"])
    # a forced Gemini run must not hide the outage behind the fallback
    failed = orchestrator.run_analysis(_session(), mode="gemini")
    assert failed["status"] == "FAILED" and failed["provider"] == "gemini"
