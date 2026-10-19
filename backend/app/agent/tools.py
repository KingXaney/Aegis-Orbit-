"""Backend tools exposed to the reasoning agent.

Every tool wraps a service-layer call, returns a structured dictionary, and
logs its execution (name, inputs, status, duration, summary). The language
model only ever sees these outputs; it never computes orbital quantities.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from ..config import get_settings
from ..physics.threat import thresholds_summary
from ..physics.time_utils import iso, parse_iso, to_unix
from ..simulation import service
from ..simulation.session import SimulationSession


class ToolError(Exception):
    pass


def _compact_pc(pc: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not pc:
        return {"status": "UNVERIFIED", "value": None, "covariance_basis": "UNAVAILABLE"}
    return {"status": pc.get("status"), "value": pc.get("value"), "covariance_basis": pc.get("covariance_basis"),
            "hard_body_radius_m": pc.get("hard_body_radius_m"), "reason": pc.get("reason")}


def compact_conjunction(sess: SimulationSession, c: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "conjunction_id": c["conjunction_id"],
        "rank": c.get("rank"),
        "secondary_id": c["secondary_id"],
        "secondary_name": c.get("secondary_name"),
        "secondary_category": c.get("secondary_category"),
        "tca": c["tca"],
        "time_to_tca_s_from_window_start": round(c["tca_unix"] - sess.scenario.start_unix, 1),
        "time_to_tca_s": round(c["tca_unix"] - (sess.clock_unix if sess.clock_unix is not None else sess.scenario.start_unix), 1),
        "miss_distance_km": round(c["miss_distance_km"], 4),
        "relative_speed_kms": round(c["relative_speed_kms"], 3),
        "pc": _compact_pc(c.get("pc")),
        "threat_state": c["threat_state"],
        "threat_rationale": c.get("threat_rationale", []),
        "models": {"primary": c["primary_model"], "secondary": c["secondary_model"]},
    }


def compact_maneuver(m: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "maneuver_id": m["maneuver_id"],
        "rank": m.get("rank"),
        "burn_time": m["burn_time"],
        "lead_time_s": round(m["lead_time_s"], 1),
        "lead_orbits": m["lead_orbits"],
        "direction": m["direction"],
        "direction_label": m["direction_label"],
        "dv_magnitude_mps": m["dv_magnitude_mps"],
        "dv_rtn_mps": m["dv_rtn_mps"],
        "post_miss_distance_km": round(m["post_miss_distance_km"], 4),
        "post_tca": m["post_tca"],
        "post_pc": _compact_pc(m.get("post_pc")),
        "post_threat_state": m["post_threat_state"],
        "baseline_miss_distance_km": round(m["baseline_miss_distance_km"], 4),
        "meets_target": m["meets_target"],
        "target_basis": m["target_basis"],
        "feasible": m["feasible"],
        "feasibility_reasons": m["feasibility_reasons"],
        "objective_score": round(m["objective_score"], 4),
        "fuel_proxy": m["fuel_proxy"],
        "propagation_model": m["propagation_model"],
        "secondary_check": m.get("secondary_check"),
    }


class ToolRegistry:
    """Session-bound tool implementations with an execution log."""

    def __init__(self, sess: SimulationSession, max_candidates: int = 3):
        self.sess = sess
        self.max_candidates = max_candidates
        self.log: List[Dict[str, Any]] = []
        self.report: Optional[Dict[str, Any]] = None
        self._handlers: Dict[str, Callable[..., Dict[str, Any]]] = {
            "list_conjunctions": self.list_conjunctions,
            "get_conjunction_details": self.get_conjunction_details,
            "plan_maneuvers": self.plan_maneuvers,
            "check_secondary": self.check_secondary,
            "generate_report": self.generate_report,
        }

    # ------------------------------------------------------------------ execution
    def execute(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        arguments = dict(arguments or {})
        handler = self._handlers.get(name)
        step = len(self.log) + 1
        started = datetime.now(timezone.utc)
        t = time.time()
        entry: Dict[str, Any] = {"step": step, "tool": name, "arguments": arguments, "status": "RUNNING",
                                 "started_at": iso(started), "duration_ms": 0.0, "summary": "", "error": None,
                                 "result_ref": None}
        self.log.append(entry)
        if handler is None:
            entry.update(status="ERROR", error=f"unknown tool '{name}'", duration_ms=round((time.time() - t) * 1000, 1))
            return {"error": entry["error"]}
        try:
            result = handler(**arguments)
            entry.update(status="OK", summary=result.get("_summary", ""), result_ref=result.get("_ref"),
                         duration_ms=round((time.time() - t) * 1000, 1))
            return {k: v for k, v in result.items() if not k.startswith("_")}
        except (service.NotFound, service.BadRequest, service.Conflict, ToolError, TypeError) as exc:
            entry.update(status="ERROR", error=str(exc), duration_ms=round((time.time() - t) * 1000, 1),
                         summary=f"failed: {exc}")
            return {"error": str(exc)}

    # ------------------------------------------------------------------ tools
    def list_conjunctions(self, window_hours: Optional[float] = None, pc_policy: Optional[str] = None,
                          rescreen: bool = False) -> Dict[str, Any]:
        sess = self.sess
        if sess.screening is None or rescreen or window_hours is not None or pc_policy is not None:
            end = None
            if window_hours is not None:
                origin = sess.clock_unix if sess.clock_unix is not None else sess.scenario.start_unix
                end = iso(origin + float(window_hours) * 3600.0)
            res = service.run_screening(sess, end=end, pc_policy=pc_policy)
            conjs = res["conjunctions"]
            stats = res["stats"]
            co_orbital = res["co_orbital"]
        else:
            conjs = [service.get_conjunction(sess, c.conjunction_id) for c in sess.ranked_conjunctions()]
            stats = sess.screening["stats"]
            co_orbital = sess.screening["co_orbital"]
        top = [compact_conjunction(sess, c) for c in conjs[:10]]
        return {
            "scenario_id": sess.scenario_id,
            "primary_id": sess.scenario.primary_id,
            "window": stats.get("window"),
            "screening_radius_km": stats.get("screening_radius_km"),
            "conjunctions": top,
            "total_found": len(conjs),
            "co_orbital_objects_excluded": [x["name"] for x in co_orbital],
            "overall_threat_state": sess.overall_threat_state(),
            "thresholds": thresholds_summary(),
            "pc_policy": sess.screening_pc_policy,
            "_summary": f"{len(conjs)} conjunction(s) inside {stats.get('screening_radius_km')} km; "
                        f"overall state {sess.overall_threat_state()}",
            "_ref": {"conjunction_ids": [c["conjunction_id"] for c in conjs[:10]]},
        }

    def get_conjunction_details(self, conjunction_id: str) -> Dict[str, Any]:
        c = service.get_conjunction(self.sess, conjunction_id)
        d = compact_conjunction(self.sess, c)
        d.update({
            "relative_position_teme_km": c["relative_position_teme_km"],
            "relative_velocity_teme_kms": c["relative_velocity_teme_kms"],
            "primary_epoch": c["primary_epoch"], "secondary_epoch": c["secondary_epoch"],
            "refinement": c["refinement"], "quality": c["quality"], "pc_full": c.get("pc"),
            "_summary": f"{conjunction_id}: miss {c['miss_distance_km']:.3f} km at {c['tca']}, state {c['threat_state']}",
            "_ref": {"conjunction_id": conjunction_id},
        })
        return d

    def plan_maneuvers(self, conjunction_id: str, max_candidates: Optional[int] = None) -> Dict[str, Any]:
        n = int(max_candidates or self.max_candidates)
        plan = service.plan_for_conjunction(self.sess, conjunction_id, max_candidates=n)
        by_id = {m["maneuver_id"]: m for m in plan["candidates"]}
        recommended = [compact_maneuver(by_id[mid]) for mid in plan["recommended_ids"]]
        return {
            "conjunction_id": conjunction_id,
            "recommended_candidates": recommended,
            "candidates_evaluated": plan["stats"]["candidates_evaluated"],
            "candidates_meeting_target": plan["stats"]["meeting_target"],
            "objective": plan["objective"],
            "assumptions": plan["assumptions"],
            "model_consistency": plan["baseline"],
            "config": plan["config"],
            "_summary": f"{plan['stats']['candidates_evaluated']} candidates evaluated, "
                        f"{len(recommended)} recommended: {', '.join(plan['recommended_ids'])}",
            "_ref": {"maneuver_ids": plan["recommended_ids"]},
        }

    def check_secondary(self, maneuver_id: str) -> Dict[str, Any]:
        res = service.run_secondary_check(self.sess, maneuver_id)
        new = [compact_conjunction(self.sess, c) for c in res["new_conjunctions"]]
        return {
            "maneuver_id": maneuver_id,
            "validation_status": res["validation_status"],
            "complete": res["complete"],
            "limitations": res["limitations"],
            "original_encounter": res["original_encounter"],
            "new_conjunctions": new,
            "changed_conjunctions": res["changed_conjunctions"],
            "worst_new_state": res["worst_new_state"],
            "_summary": f"{maneuver_id}: {res['validation_status']}, {len(new)} new conjunction(s), "
                        f"worst new state {res['worst_new_state']}",
            "_ref": {"maneuver_id": maneuver_id},
        }

    def generate_report(self, threat_conjunction_id: str, recommended_maneuver_id: Optional[str] = None,
                        threat_summary: str = "", risk_assessment: str = "", maneuver_comparison: str = "",
                        secondary_risks: str = "", recommendation_rationale: str = "", uncertainties: str = "",
                        no_action_recommended: bool = False) -> Dict[str, Any]:
        sess = self.sess
        conj = service.get_conjunction(sess, threat_conjunction_id)
        plan = sess.plans.get(threat_conjunction_id)
        considered = []
        if plan is not None:
            by_id = {m.maneuver_id: m for m in plan.candidates}
            for mid in plan.recommended_ids:
                m = by_id[mid].to_dict()
                considered.append(compact_maneuver(m))
        rec = None
        if recommended_maneuver_id:
            cand = sess.maneuvers.get(recommended_maneuver_id)
            if cand is None:
                raise ToolError(f"recommended maneuver '{recommended_maneuver_id}' does not exist in this session")
            rec = compact_maneuver(cand.to_dict())
            if recommended_maneuver_id not in [m["maneuver_id"] for m in considered]:
                considered.append(rec)
        report = {
            "generated_at": iso(datetime.now(timezone.utc)),
            "scenario_id": sess.scenario_id,
            "threat": compact_conjunction(sess, conj),
            "threat_summary": threat_summary,
            "risk_assessment": risk_assessment,
            "risk_basis": conj.get("threat_rationale", []),
            "pc_assumptions": (conj.get("pc") or {}).get("assumptions", []),
            "maneuvers_considered": considered,
            "maneuver_comparison": maneuver_comparison,
            "secondary_risks": secondary_risks,
            "secondary_checks": {mid: sess.maneuvers[mid].secondary_check for mid in
                                 [m["maneuver_id"] for m in considered] if sess.maneuvers.get(mid) and
                                 sess.maneuvers[mid].secondary_check},
            "recommended_maneuver_id": recommended_maneuver_id,
            "recommended_maneuver": rec,
            "no_action_recommended": bool(no_action_recommended),
            "recommendation_rationale": recommendation_rationale,
            "uncertainties": uncertainties,
            "planner_assumptions": plan.to_dict()["assumptions"] if plan else [],
            "thresholds": thresholds_summary(),
            "awaiting_human_decision": True,
            "note": "Numeric fields are copied from backend tool results; prose fields were written by the agent.",
        }
        self.report = report
        return {**report, "_summary": f"report generated; recommended {recommended_maneuver_id or 'no action'}",
                "_ref": {"conjunction_id": threat_conjunction_id, "maneuver_id": recommended_maneuver_id}}
