"""Simulation session: scenario state plus every computed artefact (screening,
plans, checks, committed burns, events, agent runs and human decisions). One
session per scenario is kept in memory for this single-user demo; reset
rebuilds it from scratch.

A committed burn (approved by a human, or by the sandbox autopilot) replaces
the catalog primary with a piecewise object (see propagation.MODEL_PIECEWISE),
so every reader sees the committed path; the session keeps the bookkeeping:
which burn, by whom, when, and the event log the UI shows."""
from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

from ..physics.maneuver_planner import ManeuverCandidate, PlanResult
from ..physics.screening import Conjunction
from ..physics.threat import ORDER, worst_state
from ..physics.time_utils import iso
from ..scenarios.registry import Scenario, build_scenario

MAX_EVENTS = 500
EVENTS_IN_STATE = 100

DECISION_NOTES = {
    "APPROVED": ("Simulated maneuver approved: the spacecraft's trajectory now includes the burn. "
                 "No command is sent to any spacecraft."),
    "AUTOPILOT_COMMITTED": ("Autopilot committed the burn in simulation: the trajectory now includes it. "
                            "No command is sent to any spacecraft."),
    "REJECTED": "Maneuver rejected in simulation; the original trajectory is preserved.",
    "WITHDRAWN": "Committed burn withdrawn in simulation; the trajectory returns to the previous path.",
}


def now_iso() -> str:
    return iso(datetime.now(timezone.utc))


@dataclass
class CommittedBurn:
    """A burn that is part of the primary's trajectory, with who committed it and when."""
    candidate: ManeuverCandidate
    source: str  # human | autopilot
    committed_at: str  # wall clock
    committed_at_sim_unix: Optional[float]
    secondary_check_status: Optional[str]
    meets_target: bool
    target_basis: str
    # The pass this burn was taken for, as screened before it (secondary, pre-burn TCA and miss): the
    # course a ghost of the spacecraft flies into. See service._avoided_pass.
    avoided_pass: Optional[Dict[str, Any]] = None

    @property
    def maneuver_id(self) -> str:
        return self.candidate.maneuver_id

    @property
    def burn_time_unix(self) -> float:
        return float(self.candidate.burn_time_unix)

    def to_dict(self, clock_unix: Optional[float] = None) -> Dict[str, Any]:
        d = self.candidate.to_dict()
        d.update({
            "source": self.source,
            "committed_at": self.committed_at,
            "committed_at_sim": iso(self.committed_at_sim_unix) if self.committed_at_sim_unix is not None else None,
            "committed_at_sim_unix": self.committed_at_sim_unix,
            "secondary_check_status": self.secondary_check_status,
            "meets_target": self.meets_target,
            "target_basis": self.target_basis,
            "avoided_pass": self.avoided_pass,
            "fired": bool(clock_unix is not None and self.burn_time_unix <= clock_unix),
        })
        return d


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
    post_approval: Optional[Dict[str, Any]] = None
    perception_cache: Dict[Any, Dict[str, Any]] = field(default_factory=dict)
    # Writers (screening, planning, checks, commits, spawns, evaluation) hold this; readers take snapshots.
    lock: threading.RLock = field(default_factory=threading.RLock, repr=False, compare=False)
    # Sandbox: the autopilot commits burns itself (synthetic scenario only; see service.set_autopilot).
    autopilot: bool = False
    committed: List[CommittedBurn] = field(default_factory=list)
    spawned_ids: List[str] = field(default_factory=list)
    events: List[Dict[str, Any]] = field(default_factory=list)
    event_seq: int = 0
    # The latest simulation time a client sent (``now``/``start``); time-dependent calls default to it.
    clock_unix: Optional[float] = None
    screening_window: Optional[Tuple[float, float]] = None
    # Common integration epoch for the numerical objects (see sandbox.anchor_catalog).
    anchor_epoch_unix: float = 0.0
    # Bumped on every commit/uncommit: candidates planned against an older primary are stale.
    primary_version: int = 0
    unavoidable: Dict[Tuple[str, int], Dict[str, Any]] = field(default_factory=dict)
    seen_passes: Set[Tuple[str, int]] = field(default_factory=set)
    last_evaluation: Optional[Dict[str, Any]] = None
    last_evaluation_result: Optional[Dict[str, Any]] = field(default=None, repr=False, compare=False)
    rng_seed: int = field(default_factory=lambda: int(uuid.uuid4().int & 0xFFFFFFFF))

    def __post_init__(self) -> None:
        self.autopilot = self.scenario.kind == "sandbox"
        self.anchor_epoch_unix = float(self.scenario.start_unix)

    def invalidate_perception(self) -> None:
        self.perception_cache.clear()

    @property
    def scenario_id(self) -> str:
        return self.scenario.scenario_id

    @property
    def sandbox(self) -> bool:
        return self.scenario.kind == "sandbox"

    @property
    def catalog_version(self) -> int:
        return self.scenario.catalog.version

    @property
    def approved_maneuver_id(self) -> Optional[str]:
        """The latest committed burn (compatibility with the single-approval API)."""
        return self.committed[-1].maneuver_id if self.committed else None

    def is_committed(self, maneuver_id: str) -> bool:
        return any(b.maneuver_id == maneuver_id for b in self.committed)

    def next_seed(self) -> int:
        self.rng_seed = (self.rng_seed * 1103515245 + 12345) & 0x7FFFFFFF
        return self.rng_seed

    def ranked_conjunctions(self) -> List[Conjunction]:
        return sorted(self.conjunctions.values(), key=lambda c: (c.rank if c.rank is not None else 1e9))

    def overall_threat_state(self) -> str:
        """Derived from the current conjunctions (screened against the committed path): MITIGATED when
        burns are committed and nothing worse than MONITORING remains."""
        if not self.conjunctions:
            return "MITIGATED" if self.committed else "NORMAL"
        worst = worst_state([c.threat_state for c in self.conjunctions.values()])
        if self.committed and ORDER.index(worst) <= ORDER.index("MONITORING"):
            return "MITIGATED"
        return worst

    def add_event(self, kind: str, message: str, at_unix: Optional[float] = None, **data: Any) -> Dict[str, Any]:
        self.event_seq += 1
        at = self.clock_unix if at_unix is None else float(at_unix)
        rec = {"seq": self.event_seq, "kind": kind, "message": message, "at": iso(at) if at is not None else None,
               "at_unix": at, "wall": now_iso(), **data}
        self.events.append(rec)
        if len(self.events) > MAX_EVENTS:
            del self.events[: len(self.events) - MAX_EVENTS]
        return rec

    def state_summary(self) -> Dict[str, Any]:
        ranked = self.ranked_conjunctions()
        last = self.committed[-1] if self.committed else None
        clock = self.clock_unix
        return {
            "scenario_id": self.scenario_id,
            "overall_threat_state": self.overall_threat_state(),
            "screening_performed": self.screening is not None,
            "active_conjunction_id": ranked[0].conjunction_id if ranked else None,
            "conjunction_count": len(self.conjunctions),
            "approved_maneuver_id": last.maneuver_id if last else None,
            "approved_maneuver": last.candidate.to_dict() if last else None,
            "post_approval": self.post_approval,
            "decisions": list(self.decisions),
            "agent_run_count": len(self.agent_runs),
            "reset_count": self.reset_count,
            "autopilot": self.autopilot,
            "sandbox": self.sandbox,
            "committed_maneuvers": [b.to_dict(clock) for b in self.committed],
            "burn_times_unix": [b.burn_time_unix for b in self.committed],
            "spawned_object_ids": list(self.spawned_ids),
            "catalog_version": self.catalog_version,
            "primary_version": self.primary_version,
            "clock": iso(clock) if clock is not None else None,
            "clock_unix": clock,
            "events": self.events[-EVENTS_IN_STATE:],
            "event_seq": self.event_seq,
            "last_evaluation": self.last_evaluation,
            "note": "Simulation only. Approval updates the simulated trajectory; nothing is sent to a spacecraft.",
        }

    def record_decision(self, decision_type: str, maneuver_id: str, reason: Optional[str] = None,
                        source: str = "human", note: Optional[str] = None) -> Dict[str, Any]:
        cand = self.maneuvers.get(maneuver_id)
        rec = {
            "decision_id": f"DEC-{uuid.uuid4().hex[:8]}",
            "type": decision_type,
            "maneuver_id": maneuver_id,
            "conjunction_id": cand.conjunction_id if cand else None,
            "at": now_iso(),
            "reason": reason,
            "source": source,
            "note": note or DECISION_NOTES.get(decision_type, ""),
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
