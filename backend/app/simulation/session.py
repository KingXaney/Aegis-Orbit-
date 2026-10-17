"""Simulation session: scenario state plus every computed artefact (screening,
plans, checks, agent runs and human decisions). One session per scenario is
kept in memory for this single-user demo; reset rebuilds it from scratch."""
from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from ..physics.maneuver_planner import ManeuverCandidate, PlanResult
from ..physics.screening import Conjunction
from ..physics.threat import worst_state
from ..physics.time_utils import iso
from ..scenarios.registry import Scenario, build_scenario


def now_iso() -> str:
    return iso(datetime.now(timezone.utc))


@dataclass
class SimulationSession:
    scenario: Scenario
    created_at: str = field(default_factory=now_iso)
    reset_count: int = 0
    conjunctions: Dict[str, Conjunction] = field(default_factory=dict)
    screening: Optional[Dict[str, Any]] = None
    screening_pc_policy: Optional[str] = None
    plans: Dict[str, PlanResult] = field(default_factory=dict)
    maneuvers: Dict[str, ManeuverCandidate] = field(default_factory=dict)
    secondary_checks: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    agent_runs: List[Dict[str, Any]] = field(default_factory=list)
    decisions: List[Dict[str, Any]] = field(default_factory=list)
    approved_maneuver_id: Optional[str] = None
    post_approval: Optional[Dict[str, Any]] = None

    @property
    def scenario_id(self) -> str:
        return self.scenario.scenario_id

    def ranked_conjunctions(self) -> List[Conjunction]:
        return sorted(self.conjunctions.values(), key=lambda c: (c.rank if c.rank is not None else 1e9))

    def overall_threat_state(self) -> str:
        if self.approved_maneuver_id and self.post_approval:
            return self.post_approval.get("overall_threat_state", "MITIGATED")
        if not self.conjunctions:
            return "NORMAL"
        return worst_state([c.threat_state for c in self.conjunctions.values()])

    def state_summary(self) -> Dict[str, Any]:
        ranked = self.ranked_conjunctions()
        approved = self.maneuvers.get(self.approved_maneuver_id) if self.approved_maneuver_id else None
        return {
            "scenario_id": self.scenario_id,
            "overall_threat_state": self.overall_threat_state(),
            "screening_performed": self.screening is not None,
            "active_conjunction_id": ranked[0].conjunction_id if ranked else None,
            "conjunction_count": len(self.conjunctions),
            "approved_maneuver_id": self.approved_maneuver_id,
            "approved_maneuver": approved.to_dict() if approved else None,
            "post_approval": self.post_approval,
            "decisions": list(self.decisions),
            "agent_run_count": len(self.agent_runs),
            "reset_count": self.reset_count,
            "note": "Simulation only. Approval updates the simulated trajectory; nothing is sent to a spacecraft.",
        }

    def record_decision(self, decision_type: str, maneuver_id: str, reason: Optional[str] = None) -> Dict[str, Any]:
        cand = self.maneuvers.get(maneuver_id)
        rec = {
            "decision_id": f"DEC-{uuid.uuid4().hex[:8]}",
            "type": decision_type,
            "maneuver_id": maneuver_id,
            "conjunction_id": cand.conjunction_id if cand else None,
            "at": now_iso(),
            "reason": reason,
            "note": ("Simulated maneuver approved: the displayed trajectory switches to the post-burn prediction. "
                     "No command is sent to any spacecraft." if decision_type == "APPROVED"
                     else "Maneuver rejected in simulation; the original trajectory is preserved."),
        }
        self.decisions.append(rec)
        return rec


class SessionStore:
    def __init__(self) -> None:
        self._sessions: Dict[str, SimulationSession] = {}
        self._lock = threading.Lock()

    def get(self, scenario_id: str) -> SimulationSession:
        with self._lock:
            sess = self._sessions.get(scenario_id)
            if sess is None:
                sess = SimulationSession(build_scenario(scenario_id))
                self._sessions[scenario_id] = sess
            return sess

    def reset(self, scenario_id: str, live: bool = False) -> SimulationSession:
        with self._lock:
            old = self._sessions.get(scenario_id)
            sess = SimulationSession(build_scenario(scenario_id, live=live))
            sess.reset_count = (old.reset_count + 1) if old else 0
            self._sessions[scenario_id] = sess
            return sess


_store: Optional[SessionStore] = None


def get_store() -> SessionStore:
    global _store
    if _store is None:
        _store = SessionStore()
    return _store
