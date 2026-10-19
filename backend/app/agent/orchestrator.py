"""Agent orchestration.

The agent is deterministic and rule-based: it runs a fixed tool workflow
(list_conjunctions → get_conjunction_details → plan_maneuvers → check_secondary
for every candidate → generate_report) against the physics engine, logs every
tool call, writes a templated explanation from the structured results and
validates the final recommendation against the tool outputs. Every number
shown to the user comes from a tool result; the report's numeric fields are
filled by the backend from session records. The whole flow works offline.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from ..physics.time_utils import iso
from ..simulation.session import SimulationSession
from .tools import ToolRegistry


def _now() -> str:
    return iso(datetime.now(timezone.utc))


def run_analysis(sess: SimulationSession, conjunction_id: Optional[str] = None,
                 max_candidates: int = 3) -> Dict[str, Any]:
    run = {"run_id": f"RUN-{uuid.uuid4().hex[:8]}", "scenario_id": sess.scenario_id, "provider": "deterministic",
           "status": "RUNNING", "started_at": _now(), "finished_at": None, "tool_calls": [],
           "report": None, "validation": {"status": "PENDING", "checks": []}, "narrative": "", "warnings": []}
    registry = ToolRegistry(sess, max_candidates=max_candidates)
    try:
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
# the deterministic workflow
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
