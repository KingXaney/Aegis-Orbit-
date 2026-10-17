"""Pydantic request/response schemas for the REST API.

Numeric physics results are produced by the physics package and serialised
through these models so that every value keeps its units, frame and basis.
Deeply nested diagnostic blobs (refinement details, statistics) are typed as
dictionaries.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str
    version: str
    agent_mode: str
    gemini_configured: bool
    network_allowed: bool
    scenarios: List[str]
    disclaimer: str


class ScenarioSummary(BaseModel):
    scenario_id: str
    name: str
    kind: str


class ScenarioDetail(BaseModel):
    scenario_id: str
    name: str
    kind: str
    description: str
    primary_id: str
    window: Dict[str, Any]
    object_count: int
    rendered_object_ids: List[str]
    highlight_object_ids: List[str] = []
    pc_policy: str
    data_source: Dict[str, Any]
    rejected_records: int
    disclaimers: List[str]
    thresholds: Dict[str, Any]
    simulation: "SimulationState"


class SpacecraftDesignModel(BaseModel):
    design_id: str
    label: str
    length_m: float
    width_m: float
    height_m: float
    basis: str
    reference: str = ""


class ObjectSummary(BaseModel):
    object_id: str
    name: str
    category: str
    category_basis: str
    norad_id: Optional[int] = None
    intl_designator: Optional[str] = None
    source: str
    source_detail: str
    epoch: Optional[str] = None
    retrieved_at: Optional[str] = None
    propagation_model: str
    position_basis: str
    perigee_alt_km: Optional[float] = None
    apogee_alt_km: Optional[float] = None
    period_s: Optional[float] = None
    inclination_deg: Optional[float] = None
    radius_m: float
    radius_basis: str
    covariance_source: str
    covariance_sigmas_rtn_m: Optional[List[float]] = None
    design: SpacecraftDesignModel
    validation_status: str
    warnings: List[str] = []


class ObjectListResponse(BaseModel):
    scenario_id: str
    primary_id: str
    objects: List[ObjectSummary]
    rejected_records: List[Dict[str, Any]] = []


class StateAtTime(BaseModel):
    at: str
    frame: str = "TEME"
    units: Dict[str, str]
    position_km: List[float]
    velocity_kms: List[float]
    geocentric_altitude_km: float
    geodetic: Dict[str, float]
    osculating_elements: Dict[str, float]
    status: str
    messages: List[str] = []


class ObjectDetail(ObjectSummary):
    state: Optional[StateAtTime] = None
    tle: Optional[Dict[str, str]] = None


class TrajectoryResponse(BaseModel):
    object_id: str
    scenario_id: str
    frame: str = "TEME"
    units: Dict[str, str]
    model: str
    position_basis: str
    source_epoch: Optional[str] = None
    start: str
    end: str
    step_s: float
    times_unix: List[float]
    positions_km: List[List[float]]
    velocities_kms: List[List[float]]
    status: str
    messages: List[str] = []
    segments: List[Dict[str, Any]] = []
    maneuver_id: Optional[str] = None
    burn_time: Optional[str] = None


class TrajectoryBatchRequest(BaseModel):
    scenario_id: str
    object_ids: List[str]
    start: Optional[str] = None
    end: Optional[str] = None
    step_s: float = Field(default=60.0, ge=1.0, le=3600.0)


class TrajectoryBatchResponse(BaseModel):
    trajectories: List[TrajectoryResponse]


class ScreenRequest(BaseModel):
    scenario_id: str
    primary_id: Optional[str] = None
    start: Optional[str] = None
    end: Optional[str] = None
    pc_policy: Optional[str] = Field(default=None, description="provided_only | illustrative_default")
    screening_radius_km: Optional[float] = Field(default=None, gt=0, le=200)


class ConjunctionModel(BaseModel):
    conjunction_id: str
    primary_id: str
    secondary_id: str
    tca: str
    tca_unix: float
    miss_distance_km: float
    relative_speed_kms: float
    relative_position_teme_km: List[float]
    relative_velocity_teme_kms: List[float]
    frame: str
    units: Dict[str, str]
    primary_state_teme: Dict[str, List[float]]
    secondary_state_teme: Dict[str, List[float]]
    primary_epoch: Optional[str] = None
    secondary_epoch: Optional[str] = None
    primary_model: str
    secondary_model: str
    coarse_step_s: float
    coarse_min_distance_km: float
    refinement: Dict[str, Any]
    quality: Dict[str, Any]
    pc: Optional[Dict[str, Any]] = None
    threat_state: str
    threat_rationale: List[str] = []
    rank: Optional[int] = None
    secondary_name: Optional[str] = None
    secondary_category: Optional[str] = None


class ScreenResponse(BaseModel):
    scenario_id: str
    primary_id: str
    conjunctions: List[ConjunctionModel]
    stats: Dict[str, Any]
    co_orbital: List[Dict[str, Any]] = []
    propagation_failures: List[Dict[str, Any]] = []
    overall_threat_state: str
    pc_policy: str
    thresholds: Dict[str, Any]


class PlanRequest(BaseModel):
    scenario_id: str
    max_candidates: int = Field(default=3, ge=1, le=10)
    earliest_burn: Optional[str] = None
    pc_policy: Optional[str] = None
    lead_orbits: Optional[List[float]] = None
    dv_magnitudes_mps: Optional[List[float]] = None
    directions: Optional[List[str]] = None


class ManeuverModel(BaseModel):
    maneuver_id: str
    conjunction_id: str
    burn_time: str
    burn_time_unix: float
    lead_time_s: float
    lead_orbits: float
    direction: str
    direction_label: str
    dv_rtn_mps: List[float]
    dv_teme_mps: List[float]
    dv_magnitude_mps: float
    burn_state_teme: Dict[str, List[float]]
    post_tca: str
    post_tca_unix: float
    post_miss_distance_km: float
    post_relative_speed_kms: float
    post_relative_position_teme_km: List[float]
    post_primary_state_teme: Dict[str, List[float]]
    post_secondary_state_teme: Dict[str, List[float]]
    post_pc: Optional[Dict[str, Any]] = None
    post_threat_state: str
    post_threat_rationale: List[str] = []
    baseline_miss_distance_km: float
    screening_miss_distance_km: float
    miss_distance_change_km: float
    meets_target: bool
    target_basis: str
    feasible: bool
    feasibility_reasons: List[str] = []
    validation_status: str
    objective_score: float
    objective_terms: Dict[str, float]
    propagation_model: str
    assumptions: List[str]
    fuel_proxy: Dict[str, float]
    rank: Optional[int] = None
    secondary_check: Optional[Dict[str, Any]] = None


class PlanResponse(BaseModel):
    scenario_id: str
    conjunction_id: str
    candidates: List[ManeuverModel]
    recommended_ids: List[str]
    baseline: List[Dict[str, Any]]
    config: Dict[str, Any]
    objective: str
    assumptions: List[str]
    stats: Dict[str, Any]


class SecondaryCheckRequest(BaseModel):
    scenario_id: str


class SecondaryCheckResponse(BaseModel):
    scenario_id: str
    maneuver_id: str
    screened_from: str
    screened_to: str
    primary_model: str
    new_conjunctions: List[Dict[str, Any]]
    changed_conjunctions: List[Dict[str, Any]]
    original_encounter: Dict[str, Any]
    worst_new_state: str
    complete: bool
    limitations: List[str]
    validation_status: str
    stats: Dict[str, Any]
    co_orbital: List[Dict[str, Any]] = []


class ToolCallRecord(BaseModel):
    step: int
    tool: str
    arguments: Dict[str, Any]
    status: str
    started_at: str
    duration_ms: float
    summary: str
    error: Optional[str] = None
    result_ref: Optional[Dict[str, Any]] = None


class AgentAnalyzeRequest(BaseModel):
    scenario_id: str
    conjunction_id: Optional[str] = None
    mode: Optional[str] = Field(default=None, description="auto | gemini | deterministic")
    max_candidates: int = Field(default=3, ge=1, le=6)


class AgentRunResponse(BaseModel):
    run_id: str
    scenario_id: str
    provider: str
    model: Optional[str] = None
    status: str
    started_at: str
    finished_at: Optional[str] = None
    tool_calls: List[ToolCallRecord]
    report: Optional[Dict[str, Any]] = None
    validation: Dict[str, Any]
    narrative: str
    warnings: List[str] = []
    simulation: "SimulationState"


class DecisionRecord(BaseModel):
    decision_id: str
    type: str
    maneuver_id: str
    conjunction_id: Optional[str] = None
    at: str
    reason: Optional[str] = None
    note: str


class SimulationState(BaseModel):
    scenario_id: str
    overall_threat_state: str
    screening_performed: bool
    active_conjunction_id: Optional[str] = None
    conjunction_count: int = 0
    approved_maneuver_id: Optional[str] = None
    approved_maneuver: Optional[Dict[str, Any]] = None
    post_approval: Optional[Dict[str, Any]] = None
    decisions: List[DecisionRecord] = []
    agent_run_count: int = 0
    reset_count: int = 0
    note: str


class ApproveRequest(BaseModel):
    scenario_id: str
    maneuver_id: str


class RejectRequest(BaseModel):
    scenario_id: str
    maneuver_id: str
    reason: Optional[str] = None


class DecisionResponse(BaseModel):
    decision: DecisionRecord
    maneuver: Optional[ManeuverModel] = None
    secondary_check: Optional[Dict[str, Any]] = None
    simulation: SimulationState


class DataRefreshResponse(BaseModel):
    status: str
    detail: str
    groups: List[Dict[str, Any]] = []


ScenarioDetail.model_rebuild()
AgentRunResponse.model_rebuild()
