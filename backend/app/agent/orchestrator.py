"""Agent orchestration.

Two providers implement the same workflow and produce the same report shape:

* ``gemini`` – Google Gemini with function calling. The model decides which
  tools to call; the backend executes them, logs every call and validates the
  final recommendation against the tool results.
* ``deterministic`` – a rule-based fallback used when no API key is configured
  (or on request). It runs the identical tool sequence and writes a templated
  explanation from the structured results, so the end-to-end demo works
  offline. The UI labels which provider produced a run.

In both cases every number shown to the user comes from a tool result; the
report's numeric fields are filled by the backend from session records.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from ..config import get_settings
from ..physics.time_utils import iso
from ..simulation import service
from ..simulation.session import SimulationSession
from .tools import ToolRegistry, function_declarations

SYSTEM_PROMPT = """You are the reasoning layer of a spacecraft collision-avoidance simulator. You explain and
recommend; you never compute orbital numbers yourself. Every quantity you mention must come from a tool result,
and you must refer to conjunctions and maneuvers by the IDs the tools return.

Workflow (follow it in order, one tool call at a time):
1. list_conjunctions to find the ranked close approaches for the selected satellite.
2. Pick the highest-ranked threat (or the conjunction the user named) and call get_conjunction_details.
3. Call plan_maneuvers for that conjunction (2-3 candidates).
4. Call check_secondary for EVERY candidate you might recommend.
5. Call generate_report exactly once with your explanation text and the recommended maneuver ID.

Rules:
- Threat states (NORMAL, MONITORING, ELEVATED, CRITICAL, MITIGATED, UNVERIFIED) are assigned by the backend; report
  them as given and never upgrade or downgrade them yourself.
- If the collision probability status is UNVERIFIED, say clearly that it could not be computed and why; do not invent
  a probability. If it is based on illustrative covariance, say so.
- Distinguish computed values, configured thresholds, assumptions and illustrative estimates.
- Recommend only a candidate that is feasible, meets the configured target and passed secondary screening (PASS or
  LIMITED with an explanation). If none does, set no_action_recommended=true and explain.
- Explain trade-offs (delta-v cost vs. risk reduction vs. lead time) and the uncertainties that limit the conclusion.
- Approval is a human decision; end by stating that the recommendation awaits approval. This is a simulation and no
  spacecraft is commanded."""


def _now() -> str:
    return iso(datetime.now(timezone.utc))


def _select_provider(mode: Optional[str]) -> (str, List[str]):
    s = get_settings()
    warnings: List[str] = []
    mode = (mode or s.agent_mode or "auto").lower()
    if mode == "gemini":
        if not s.gemini_api_key:
            warnings.append("Gemini requested but GEMINI_API_KEY is not configured; using the deterministic fallback")
            return "deterministic", warnings
        return "gemini", warnings
    if mode == "deterministic":
        return "deterministic", warnings
    if s.gemini_api_key:
        return "gemini", warnings
    warnings.append("GEMINI_API_KEY not configured; using the deterministic fallback agent")
    return "deterministic", warnings


def run_analysis(sess: SimulationSession, conjunction_id: Optional[str] = None, mode: Optional[str] = None,
                 max_candidates: int = 3) -> Dict[str, Any]:
    provider, warnings = _select_provider(mode)
    run = {"run_id": f"RUN-{uuid.uuid4().hex[:8]}", "scenario_id": sess.scenario_id, "provider": provider,
           "model": None, "status": "RUNNING", "started_at": _now(), "finished_at": None, "tool_calls": [],
           "report": None, "validation": {"status": "PENDING", "checks": []}, "narrative": "", "warnings": warnings}
    registry = ToolRegistry(sess, max_candidates=max_candidates)
    forced_gemini = (mode or get_settings().agent_mode or "auto").lower() == "gemini"
    try:
        if provider == "gemini":
            outage = _run_gemini_chain(sess, registry, conjunction_id, run)
            if outage is not None:
                if forced_gemini:  # an explicit Gemini request must not hide the outage behind the fallback
                    raise outage
                run["provider"], run["model"] = "deterministic", None
                run["warnings"].append("Gemini could not serve this run; the deterministic fallback agent produced it with the same tools")
                _run_deterministic(sess, registry, conjunction_id, run)
        else:
            _run_deterministic(sess, registry, conjunction_id, run)
    except Exception as exc:  # the run record must always be returned to the UI
        run["status"] = "FAILED"
        run["warnings"].append(f"agent run failed: {exc}")
    run["tool_calls"] = registry.log
    if registry.report is not None:
        run["report"] = registry.report
        run["validation"] = validate_report(sess, registry.report, registry.log)
        if run["status"] != "FAILED":
            run["status"] = "NEEDS_APPROVAL" if run["validation"]["status"] == "VALID" else "INVALID"
        run["narrative"] = run["narrative"] or narrative_from_report(registry.report)
    elif run["status"] != "FAILED":
        run["status"] = "INCOMPLETE"
        run["warnings"].append("the agent finished without producing a report")
    run["finished_at"] = _now()
    run["simulation"] = sess.state_summary()
    sess.agent_runs.append(run)
    return run


# --------------------------------------------------------------------------
# deterministic fallback
# --------------------------------------------------------------------------

def _fmt_pc(pc: Dict[str, Any]) -> str:
    if not pc or pc.get("status") != "COMPUTED" or pc.get("value") is None:
        return "not computable (UNVERIFIED: " + (pc.get("reason") or "no covariance") + ")" if pc else "not computable"
    basis = pc.get("covariance_basis")
    tag = "illustrative covariance" if basis != "PROVIDED" else "provided covariance"
    return f"{pc['value']:.2e} ({tag})"


def _run_deterministic(sess: SimulationSession, reg: ToolRegistry, conjunction_id: Optional[str], run: Dict[str, Any]) -> None:
    listing = reg.execute("list_conjunctions", {})
    if "error" in listing:
        raise RuntimeError(listing["error"])
    conjs = listing["conjunctions"]
    if not conjs:
        run["narrative"] = ("Screening found no close approach inside the configured screening radius during the window. "
                            "No maneuver is needed; the scenario remains NORMAL.")
        run["status"] = "COMPLETED"
        return
    target = conjunction_id or conjs[0]["conjunction_id"]
    details = reg.execute("get_conjunction_details", {"conjunction_id": target})
    if "error" in details:
        raise RuntimeError(details["error"])
    plan = reg.execute("plan_maneuvers", {"conjunction_id": target, "max_candidates": reg.max_candidates})
    if "error" in plan:
        raise RuntimeError(plan["error"])
    checks = {}
    for cand in plan["recommended_candidates"]:
        checks[cand["maneuver_id"]] = reg.execute("check_secondary", {"maneuver_id": cand["maneuver_id"]})
    acceptable = [c for c in plan["recommended_candidates"] if c["feasible"] and c["meets_target"]
                  and checks[c["maneuver_id"]].get("validation_status") in ("PASS", "LIMITED")]
    recommended = acceptable[0] if acceptable else None

    pc_txt = _fmt_pc(details["pc"])
    threat_summary = (f"{details['secondary_name'] or details['secondary_id']} ({details['secondary_category'] or 'unknown category'}, "
                      f"{details['secondary_id']}) approaches the primary to {details['miss_distance_km']:.3f} km at "
                      f"{details['tca']} (T+{details['time_to_tca_s_from_window_start'] / 3600:.2f} h into the window) with a "
                      f"relative speed of {details['relative_speed_kms']:.2f} km/s. Backend threat state: {details['threat_state']}.")
    risk = (f"Collision probability: {pc_txt}. Basis: " + "; ".join(details.get("threat_rationale", [])) +
            ". Positions come from " + details["models"]["primary"] + " (primary) and " + details["models"]["secondary"] +
            " (secondary) propagation; the closest approach was refined to " +
            f"{details['refinement'].get('tolerance_s', 0.001)} s.")
    comp_lines = []
    for c in plan["recommended_candidates"]:
        chk = checks[c["maneuver_id"]]
        comp_lines.append(
            f"{c['maneuver_id']}: {c['direction_label']} burn of {c['dv_magnitude_mps']:.2f} m/s at {c['burn_time']} "
            f"({c['lead_orbits']:g} orbits before TCA) raises the miss distance from {c['baseline_miss_distance_km']:.3f} km to "
            f"{c['post_miss_distance_km']:.3f} km; post-maneuver Pc {_fmt_pc(c['post_pc'])}; "
            f"{'meets' if c['meets_target'] else 'does not meet'} the target ({c['target_basis']}); "
            f"secondary screening {chk.get('validation_status', 'not run')} with {len(chk.get('new_conjunctions', []))} new "
            f"conjunction(s). Uses {c['fuel_proxy']['fraction_of_budget'] * 100:.0f}% of the delta-v budget.")
    comparison = " ".join(comp_lines)
    sec_lines = []
    for mid, chk in checks.items():
        if "error" in chk:
            sec_lines.append(f"{mid}: secondary check failed ({chk['error']}).")
            continue
        new = chk.get("new_conjunctions", [])
        if new:
            worst = new[0]
            sec_lines.append(f"{mid}: {len(new)} new approach(es), closest {worst['miss_distance_km']:.2f} km with "
                             f"{worst['secondary_name'] or worst['secondary_id']} ({worst['threat_state']}).")
        else:
            sec_lines.append(f"{mid}: no new approach inside the screening radius; " + "; ".join(chk.get("limitations", [])) + ".")
    secondary_txt = " ".join(sec_lines)
    if recommended:
        others = [c for c in plan["recommended_candidates"] if c["maneuver_id"] != recommended["maneuver_id"]]
        rationale = (f"{recommended['maneuver_id']} is the lowest-cost candidate that meets the configured target and passed "
                     f"secondary screening (objective score {recommended['objective_score']:.3f}: {plan['objective']}). ")
        if others:
            rationale += "Alternatives " + ", ".join(
                f"{o['maneuver_id']} ({o['dv_magnitude_mps']:.2f} m/s, {o['post_miss_distance_km']:.2f} km)" for o in others) + \
                " achieve larger separations at higher delta-v cost or with less margin on the target."
    else:
        rationale = ("No candidate both meets the configured target and passed secondary screening, so no maneuver is "
                     "recommended from this grid; widen the search or review the candidates manually.")
    uncertainties = ("Assumptions: " + "; ".join(plan.get("assumptions", [])) + ". Pc assumptions: " +
                     "; ".join(details.get("pc_full", {}).get("assumptions", []) if details.get("pc_full") else
                               ["no covariance available, so no probability was computed"]) +
                     ". Model consistency (two-body+J2 vs. screening model for the un-maneuvered primary): " +
                     "; ".join(f"{row.get('lead_orbits')} orbits: {row.get('model_difference_km', 0):+.3f} km"
                               for row in plan.get("model_consistency", []) if "model_difference_km" in row) +
                     ". This is a simulation; the recommendation awaits human approval and nothing is sent to a spacecraft.")
    reg.execute("generate_report", {
        "threat_conjunction_id": target,
        "recommended_maneuver_id": recommended["maneuver_id"] if recommended else None,
        "no_action_recommended": recommended is None,
        "threat_summary": threat_summary,
        "risk_assessment": risk,
        "maneuver_comparison": comparison,
        "secondary_risks": secondary_txt,
        "recommendation_rationale": rationale,
        "uncertainties": uncertainties,
    })


# --------------------------------------------------------------------------
# Gemini
# --------------------------------------------------------------------------

def _run_gemini_chain(sess: SimulationSession, reg: ToolRegistry, conjunction_id: Optional[str], run: Dict[str, Any]):
    """Try the configured model and then its fallbacks; None once one of them completed the run, else the last outage."""
    from .gemini_client import GeminiUnavailable

    chain = get_settings().gemini_model_chain
    last: Optional[GeminiUnavailable] = None
    for i, model in enumerate(chain):
        run["model"] = model
        try:
            _run_gemini(sess, reg, conjunction_id, run, model)
            return None
        except GeminiUnavailable as exc:
            last = exc
            more = i + 1 < len(chain)
            run["warnings"].append(f"{model} unavailable ({exc.reason})" + ("; trying the next model" if more else ""))
    return last


def _run_gemini(sess: SimulationSession, reg: ToolRegistry, conjunction_id: Optional[str], run: Dict[str, Any],
                model: Optional[str] = None) -> None:
    from .gemini_client import GeminiClient

    s = get_settings()
    client = GeminiClient(api_key=s.gemini_api_key, model=model or s.gemini_model, system_instruction=SYSTEM_PROMPT,
                          declarations=function_declarations(), attempts=s.gemini_retry_attempts,
                          base_delay_s=s.gemini_retry_base_s)
    scen = sess.scenario
    prompt = (f"Scenario '{scen.name}' ({scen.kind}). Primary object: {scen.primary_id}. Window {iso(scen.start_unix)} to "
              f"{iso(scen.end_unix)}. ")
    prompt += (f"Analyse conjunction {conjunction_id}." if conjunction_id else
               "Find the most significant close approach, evaluate avoidance maneuvers and recommend one.")
    prompt += " Use the tools; do not estimate any number yourself."
    turn = client.start(prompt)
    calls_made = 0
    nudged = False
    while True:
        if turn.function_calls:
            results = []
            for call in turn.function_calls:
                if calls_made >= s.agent_max_tool_calls:
                    results.append({"name": call["name"], "response": {"error": "tool-call budget exhausted; call generate_report now"}})
                    continue
                calls_made += 1
                out = reg.execute(call["name"], call["args"])
                results.append({"name": call["name"], "response": out})
            if reg.report is not None:
                run["narrative"] = narrative_from_report(reg.report)
                return
            turn = client.send_tool_results(results)
            continue
        # No function call: the model produced text.
        if reg.report is None and not nudged:
            nudged = True
            turn = client.send_tool_results([{"name": "system", "response": {
                "instruction": "You have not called generate_report yet. Call generate_report now with your explanation and the recommended maneuver ID (or no_action_recommended=true)."}}])
            continue
        if turn.text:
            run["narrative"] = turn.text
        return


# --------------------------------------------------------------------------
# validation + narrative
# --------------------------------------------------------------------------

def validate_report(sess: SimulationSession, report: Dict[str, Any], log: List[Dict[str, Any]]) -> Dict[str, Any]:
    checks: List[Dict[str, Any]] = []

    def check(name: str, ok: bool, detail: str) -> None:
        checks.append({"check": name, "ok": bool(ok), "detail": detail})

    cid = report["threat"]["conjunction_id"]
    conj = sess.conjunctions.get(cid)
    check("threat_exists", conj is not None, f"conjunction {cid} present in the screening results")
    if conj is not None:
        check("threat_numbers_match", abs(report["threat"]["miss_distance_km"] - conj.miss_distance_km) < 1e-3,
              "report miss distance equals the screening record")
    mid = report.get("recommended_maneuver_id")
    if mid:
        cand = sess.maneuvers.get(mid)
        check("maneuver_exists", cand is not None, f"maneuver {mid} exists in the session")
        if cand is not None:
            check("maneuver_feasible", cand.feasible, "; ".join(cand.feasibility_reasons) or "feasible")
            check("maneuver_meets_target", cand.meets_target, cand.target_basis)
            chk = sess.secondary_checks.get(mid)
            check("secondary_check_run", chk is not None, "secondary screening executed for the recommendation")
            if chk is not None:
                check("secondary_check_passed", chk["validation_status"] in ("PASS", "LIMITED"),
                      f"secondary screening status {chk['validation_status']}")
            check("belongs_to_threat", cand.conjunction_id == cid, "recommended maneuver targets the reported threat")
    else:
        check("no_action_explicit", bool(report.get("no_action_recommended")),
              "no maneuver recommended and the report says so explicitly")
    tools_used = [e["tool"] for e in log if e["status"] == "OK"]
    check("tool_sequence", all(t in tools_used for t in ("list_conjunctions", "get_conjunction_details", "generate_report")),
          f"tools used: {', '.join(tools_used)}")
    errors = [e for e in log if e["status"] == "ERROR"]
    check("no_tool_errors", not errors, f"{len(errors)} tool call(s) failed" if errors else "all tool calls succeeded")
    ok = all(c["ok"] for c in checks if c["check"] != "no_tool_errors")
    return {"status": "VALID" if ok else "INVALID", "checks": checks}


def narrative_from_report(report: Dict[str, Any]) -> str:
    parts = [report.get("threat_summary", ""), report.get("risk_assessment", ""), report.get("maneuver_comparison", ""),
             report.get("secondary_risks", ""), report.get("recommendation_rationale", ""), report.get("uncertainties", "")]
    text = "\n\n".join(p for p in parts if p)
    if report.get("recommended_maneuver_id"):
        text += f"\n\nRecommendation: {report['recommended_maneuver_id']} — awaiting human approval (simulation only)."
    else:
        text += "\n\nRecommendation: no maneuver — awaiting human acknowledgement (simulation only)."
    return text
