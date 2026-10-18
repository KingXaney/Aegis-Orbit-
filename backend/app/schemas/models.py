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
    gemini_model: str
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
    sandbox: bool = False
    screening_shortlist: Optional[Dict[str, Any]] = None


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
    base_model: Optional[str] = Field(default=None, description="native model once committed burns make it PIECEWISE_J2")
    burns: List[Dict[str, Any]] = []
    spawned_at: Optional[str] = None
    spawned_at_unix: Optional[float] = None
    spawn: Optional[Dict[str, Any]] = None


class ObjectListResponse(BaseModel):
    scenario_id: str
    primary_id: str
    objects: List[ObjectSummary]
    rejected_records: List[Dict[str, Any]] = []
    catalog_total: Optional[int] = None
    partial: bool = Field(default=False, description="only the primary, rendered and shortlisted objects are listed")


class CatalogTlesResponse(BaseModel):
    scenario_id: str
    primary_id: str
    count: int
    fields: List[str]
    rows: List[List[str]]
    source: Optional[str] = None
    retrieved_at: Optional[str] = None


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
    # null samples: propagation failures, and the time before a spawned object existed
    positions_km: List[List[Optional[float]]]
    velocities_kms: List[List[Optional[float]]]
    status: str
    messages: List[str] = []
    segments: List[Dict[str, Any]] = []
    maneuver_id: Optional[str] = None
    burn_time: Optional[str] = None
    burn_times_unix: List[float] = []
    variant: str = Field(default="original", description="original | committed | candidate | before_burn")


class TrajectoryBatchRequest(BaseModel):
    scenario_id: str
    object_ids: List[str]
    start: Optional[str] = None
    end: Optional[str] = None
    step_s: float = Field(default=60.0, ge=1.0, le=3600.0)
    variant: Optional[str] = None


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
    primary_version: Optional[int] = None


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
    worst_changed_state: Optional[str] = None
    window_end_unix: Optional[float] = None
    catalog_version: Optional[int] = None
    primary_version: Optional[int] = None
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
    source: Optional[str] = None
    note: str


class SimulationState(BaseModel):
    scenario_id: str
    overall_threat_state: str
    screening_performed: bool
    active_conjunction_id: Optional[str] = None
    conjunction_count: int = 0
    approved_maneuver_id: Optional[str] = Field(default=None, description="the latest committed burn")
    approved_maneuver: Optional[Dict[str, Any]] = None
    post_approval: Optional[Dict[str, Any]] = None
    decisions: List[DecisionRecord] = []
    agent_run_count: int = 0
    reset_count: int = 0
    autopilot: bool = False
    sandbox: bool = False
    committed_maneuvers: List[Dict[str, Any]] = []
    burn_times_unix: List[float] = []
    spawned_object_ids: List[str] = []
    catalog_version: int = 0
    primary_version: int = 0
    clock: Optional[str] = Field(default=None, description="the latest simulation time a client sent")
    clock_unix: Optional[float] = None
    events: List[Dict[str, Any]] = []
    event_seq: int = 0
    last_evaluation: Optional[Dict[str, Any]] = None
    note: str


class AutopilotRequest(BaseModel):
    scenario_id: str
    enabled: bool


class SpawnRequest(BaseModel):
    scenario_id: str
    now: str = Field(description="simulation time of the spawn, ISO 8601 UTC")
    kind: str = Field(description="fragment | rocket_body | dead_satellite")
    time_to_tca_s: Optional[float] = Field(default=None, ge=0, description="closest approach this many seconds after now")
    drop_point: Optional[Dict[str, float]] = Field(default=None, description="{lat_deg, lon_deg}: the pass happens over this spot")
    offset_km: Optional[float] = Field(default=None, gt=0, le=100, description="explicit miss distance instead of the kind's band")
    axis: str = Field(default="horizontal", description="horizontal | radial, where an explicit offset points")
    crossing_angle_deg: Optional[float] = Field(default=None, ge=-179, le=179)
    seed: Optional[int] = Field(default=None, ge=0)
    name: Optional[str] = None


class SpawnResponse(BaseModel):
    object: ObjectSummary
    designed: Dict[str, Any]
    spawned_at: str
    catalog_version: int
    events: List[Dict[str, Any]] = []
    simulation: SimulationState


class DrillRequest(BaseModel):
    now: str = Field(description="simulation time of the injection, ISO 8601 UTC")


class DrillResponse(BaseModel):
    scenario_id: str
    now: str
    now_unix: float
    object: ObjectSummary
    designed: Dict[str, Any]
    screening: "ScreenResponse"


class SpawnRandomRequest(BaseModel):
    scenario_id: str
    now: str
    count: int = Field(default=5, ge=1, le=20)
    seed: Optional[int] = Field(default=None, ge=0)


class SpawnBatchResponse(BaseModel):
    objects: List[ObjectSummary]
    designed: List[Dict[str, Any]]
    seed: int
    catalog_version: int
    events: List[Dict[str, Any]] = []
    simulation: SimulationState


class RemoveRequest(BaseModel):
    scenario_id: str
    now: str
    object_ids: Optional[List[str]] = Field(default=None, description="specific spawned objects to remove")
    count: Optional[int] = Field(default=None, ge=1, le=25, description="or this many of the most recently spawned")


class RemoveResponse(BaseModel):
    removed: List[str]
    events: List[Dict[str, Any]] = []
    catalog_version: int
    simulation: SimulationState


class EvaluateRequest(BaseModel):
    scenario_id: str
    now: str
    earliest_burn_after_s: Optional[float] = Field(default=None, ge=0, description="planning latency margin: no burn sooner than this")


class EvaluateResponse(BaseModel):
    scenario_id: str
    now: str
    now_unix: float
    cached: bool = False
    anchored: int = 0
    screening: Dict[str, Any]
    conjunctions: List[ConjunctionModel]
    actions: List[Dict[str, Any]]
    committed_maneuvers: List[Dict[str, Any]] = []
    events_added: List[Dict[str, Any]] = []
    simulation: SimulationState


class JunkTypesResponse(BaseModel):
    kinds: List[Dict[str, Any]]
    min_time_to_tca_s: float
    max_random_count: int
    max_objects: int


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


class PerceptionML(BaseModel):
    score: Optional[float] = None
    predicted_tier: Optional[str] = None
    model_version: Optional[str] = None
    basis: str
    note: Optional[str] = None
    elements_basis: Optional[str] = None


class PerceptionTrail(BaseModel):
    frame: str
    center_unix: float
    step_s: float
    times_unix: List[float]
    positions_rtn_km: List[List[float]]
    basis: str


class PerceptionPhysics(BaseModel):
    status: str
    verified: bool
    conjunction_id: Optional[str] = None
    linked_conjunction_id: Optional[str] = None
    link_basis: Optional[str] = None
    clearance: Optional[str] = None
    tca: Optional[str] = None
    tca_unix: Optional[float] = None
    time_to_tca_s: Optional[float] = None
    miss_distance_km: Optional[float] = None
    relative_speed_kms: Optional[float] = None
    miss_vector_rtn_km: Optional[List[float]] = None
    relative_velocity_rtn_kms: Optional[List[float]] = None
    relative_position_teme_km: Optional[List[float]] = None
    threat_state: Optional[str] = None
    threat_rationale: List[str] = []
    pc: Optional[Dict[str, Any]] = None
    coarse_min_distance_km: Optional[float] = None
    coarse_min_at: Optional[str] = None
    models: Dict[str, Optional[str]] = {}
    segment: Optional[str] = None


class PerceptionObject(BaseModel):
    object_id: str
    name: str
    category: str
    tier: str
    rank: int
    ml: PerceptionML
    physics: PerceptionPhysics
    trail: Optional[PerceptionTrail] = None


class PerceptionModelInfo(BaseModel):
    status: str
    library: Optional[str] = None
    library_version: Optional[str] = None
    model_version: Optional[str] = None
    artifact: Optional[str] = None
    feature_version: int
    feature_names: List[str]
    trained_at: Optional[str] = None
    data_retrieved_at: Dict[str, str] = {}
    training: Dict[str, Any] = {}
    metrics: Dict[str, Any] = {}
    feature_importance: Dict[str, float] = {}
    threshold: Optional[float] = None
    threshold_basis: Optional[str] = None
    artifacts: Dict[str, Any] = {}
    reason: Optional[str] = None
    basis: str


class PerceptionResponse(BaseModel):
    scenario_id: str
    primary_id: str
    primary_variant: Dict[str, Any]
    horizon: Dict[str, Any]
    thresholds: Dict[str, Any]
    tier_rules: List[str]
    screening_mode: str
    objects: List[PerceptionObject]
    counts: Dict[str, int]
    funnel: Optional[Dict[str, Any]] = None
    model: PerceptionModelInfo
    stats: Dict[str, Any]
    co_orbital: List[Dict[str, Any]] = []
    propagation_failures: List[Dict[str, Any]] = []
    complete: bool
    limitations: List[str] = []
    disclaimer: str
    cached: bool = False


class CatalogObject(BaseModel):
    norad_id: int
    name: str
    type: str = Field(description="PAYLOAD | DEBRIS | ROCKET_BODY")
    owner: Optional[str] = Field(default=None, description="SATCAT owner/operator code")
    launch_date: Optional[str] = None
    intl_designator: Optional[str] = None
    orbit_class: str = Field(description="LEO | MEO | GEO | HEO")
    inclination_deg: float
    period_min: float
    perigee_km: float
    apogee_km: float
    epoch: str
    tle1: str
    tle2: str


class CatalogResponse(BaseModel):
    source: str
    origin: str = Field(description="cache | fixture")
    retrieved_at: Optional[str] = None
    note: str
    total: int
    rejected: int
    counts_by_type: Dict[str, int]
    objects: List[CatalogObject]


class CatalogRefreshResponse(BaseModel):
    status: str
    retrieved_at: Optional[str] = None
    detail: str


class ApproachRecord(BaseModel):
    norad_id: int
    name: str
    type: str = Field(description="PAYLOAD | DEBRIS | ROCKET_BODY")
    tca: str = Field(description="Time of closest approach, ISO 8601 UTC")
    tca_unix: float
    miss_distance_km: float
    relative_speed_kms: float
    threat_state: str = Field(description="Simulator threat state without covariance: UNVERIFIED or MONITORING")
    critical: bool = Field(description="Misses the distance-based mitigation target, so the simulator would plan a burn")
    primary_position_teme_km: List[float] = Field(description="GPM's TEME position at TCA")
    secondary_position_teme_km: List[float]


class ApproachesResponse(BaseModel):
    primary_norad_id: int
    primary_name: str
    window_start: str
    window_end: str
    computed_at: str
    compute_s: float
    catalog_retrieved_at: Optional[str] = None
    screened: int = Field(description="Objects screened against the primary")
    screening_radius_km: float
    critical_distance_km: float = Field(description="Passes closer than this are critical (miss_distance_target_km)")
    approaches: List[ApproachRecord] = Field(description="Approaches still ahead, soonest first")
    note: str


ScenarioDetail.model_rebuild()
AgentRunResponse.model_rebuild()
