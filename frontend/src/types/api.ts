// Mirrors backend/app/schemas/models.py. All timestamps are ISO 8601 UTC strings;
// positions are km in the TEME frame; velocities km/s; delta-v m/s.

export type ThreatState = 'NORMAL' | 'MONITORING' | 'ELEVATED' | 'CRITICAL' | 'MITIGATED' | 'UNVERIFIED';

export interface HealthResponse {
  status: string;
  version: string;
  agent_mode: string;
  gemini_configured: boolean;
  gemini_model: string;
  network_allowed: boolean;
  scenarios: string[];
  disclaimer: string;
}

export type ScenarioKind = 'real' | 'synthetic' | 'sandbox';

export interface ScenarioSummary {
  scenario_id: string;
  name: string;
  kind: ScenarioKind;
}

export interface Window {
  start: string;
  end: string;
  start_unix: number;
  end_unix: number;
}

export interface DecisionRecord {
  decision_id: string;
  type: 'APPROVED' | 'REJECTED' | 'AUTOPILOT_COMMITTED';
  maneuver_id: string;
  conjunction_id: string | null;
  at: string;
  reason: string | null;
  source?: 'human' | 'autopilot' | null;
  note: string;
}

/**
 * The pass a committed burn was taken for, as screened before the burn: the course the spacecraft's
 * ghost flies into. `basis` says whether the screened conjunction was still at hand when the burn was
 * committed or the values come from the candidate alone.
 */
export interface AvoidedPass {
  conjunction_id: string;
  secondary_id: string | null;
  secondary_name: string | null;
  tca: string;
  tca_unix: number;
  miss_km: number;
  relative_speed_kms: number | null;
  threat_state: ThreatState | null;
  /** The un-burned primary's TEME position at the pass (km), when screened. */
  ghost_r_km: number[] | null;
  secondary_r_km: number[] | null;
  basis: 'screening' | 'candidate';
}

/** A burn that is part of the primary's trajectory (approved by a human or committed by the autopilot). */
export interface CommittedManeuver extends Maneuver {
  source: 'human' | 'autopilot';
  committed_at: string;
  committed_at_sim: string | null;
  committed_at_sim_unix: number | null;
  secondary_check_status: string | null;
  /** The burn time has passed at the backend's last known clock. */
  fired: boolean;
  avoided_pass?: AvoidedPass | null;
}

export type SimulationEventKind =
  | 'COMMITTED'
  | 'UNCOMMITTED'
  | 'AUTOPILOT'
  | 'SPAWNED'
  | 'CLOSEST_APPROACH'
  | 'AWAITING_APPROVAL'
  | 'UNAVOIDABLE'
  | 'ANCHORED';

export interface SimulationEvent {
  seq: number;
  kind: SimulationEventKind | string;
  message: string;
  /** Simulation time of the event (null when it has no simulation time). */
  at: string | null;
  at_unix: number | null;
  /** Wall-clock time the backend recorded it. */
  wall: string;
  object_id?: string;
  conjunction_id?: string;
  maneuver_id?: string;
  secondary_id?: string | null;
  tca_unix?: number;
  miss_km?: number;
  post_miss_km?: number;
  burn_time_unix?: number;
  threat_state?: ThreatState;
  reason?: string;
  source?: string;
  junk_kind?: JunkKind;
}

export interface PostApproval {
  maneuver_id: string;
  conjunction_id: string;
  post_miss_distance_km: number;
  post_tca: string;
  post_pc: PcResult | null;
  post_threat_state: ThreatState;
  meets_target: boolean;
  target_basis: string;
  secondary_check_status: string;
  new_conjunctions: number;
  overall_threat_state: ThreatState;
  approved_at: string;
}

export interface SimulationState {
  scenario_id: string;
  overall_threat_state: ThreatState;
  screening_performed: boolean;
  active_conjunction_id: string | null;
  conjunction_count: number;
  approved_maneuver_id: string | null;
  approved_maneuver: Maneuver | null;
  post_approval: PostApproval | null;
  decisions: DecisionRecord[];
  agent_run_count: number;
  reset_count: number;
  /** Sandbox: the simulation commits avoidance burns itself. */
  autopilot: boolean;
  sandbox: boolean;
  committed_maneuvers: CommittedManeuver[];
  burn_times_unix: number[];
  spawned_object_ids: string[];
  catalog_version: number;
  primary_version: number;
  /** The latest simulation time the backend was told about (ISO), null before any. */
  clock: string | null;
  clock_unix: number | null;
  events: SimulationEvent[];
  event_seq: number;
  note: string;
}

export interface ScenarioDetail {
  scenario_id: string;
  name: string;
  kind: ScenarioKind;
  description: string;
  primary_id: string;
  window: Window;
  object_count: number;
  rendered_object_ids: string[];
  highlight_object_ids: string[];
  pc_policy: string;
  data_source: Record<string, unknown>;
  rejected_records: number;
  disclaimers: string[];
  thresholds: Record<string, unknown>;
  simulation: SimulationState;
  sandbox: boolean;
}

/** Envelope in the local orbital frame: length in-track, width cross-track, height radial (metres). */
export interface SpacecraftDesign {
  design_id: string;
  label: string;
  length_m: number;
  width_m: number;
  height_m: number;
  basis: string; // PUBLISHED_SPEC | SCENARIO_DEFINITION | SIZED_FROM_HARD_BODY_RADIUS
  reference: string;
}

export interface ObjectSummary {
  object_id: string;
  name: string;
  category: string;
  category_basis: string;
  norad_id: number | null;
  intl_designator: string | null;
  source: string;
  source_detail: string;
  epoch: string | null;
  retrieved_at: string | null;
  propagation_model: string;
  position_basis: string;
  perigee_alt_km: number | null;
  apogee_alt_km: number | null;
  period_s: number | null;
  inclination_deg: number | null;
  radius_m: number;
  radius_basis: string;
  covariance_source: string;
  covariance_sigmas_rtn_m: number[] | null;
  design: SpacecraftDesign;
  validation_status: string;
  warnings: string[];
  /** Native model once committed burns make the object PIECEWISE_J2. */
  base_model?: string | null;
  burns?: { maneuver_id: string; burn_time: string; burn_time_unix: number; dv_mps: number; direction: string }[];
  /** Sandbox junk: when it was spawned (simulation time). */
  spawned_at?: string | null;
  spawned_at_unix?: number | null;
  spawn?: (Record<string, unknown> & { kind?: JunkKind; tca_unix?: number; miss_km?: number; band_km?: number[] }) | null;
}

export interface StateAtTime {
  at: string;
  frame: string;
  units: Record<string, string>;
  position_km: number[];
  velocity_kms: number[];
  geocentric_altitude_km: number;
  geodetic: { lat_deg?: number; lon_deg?: number; alt_km?: number };
  osculating_elements: Record<string, number>;
  status: string;
  messages: string[];
}

export interface ObjectDetail extends ObjectSummary {
  state: StateAtTime | null;
  tle: { line1: string; line2: string } | null;
}

export interface TrajectorySegment {
  start: string;
  end: string;
  model: string;
  label: string;
  maneuver_id?: string | null;
}

export interface Trajectory {
  object_id: string;
  scenario_id: string;
  frame: string;
  units: Record<string, string>;
  model: string;
  position_basis: string;
  source_epoch: string | null;
  start: string;
  end: string;
  step_s: number;
  times_unix: number[];
  positions_km: (number | null)[][];
  velocities_kms: (number | null)[][];
  status: string;
  messages: string[];
  segments: TrajectorySegment[];
  maneuver_id: string | null;
  burn_time: string | null;
  /** Committed (or previewed) burns along this path. */
  burn_times_unix?: number[];
  variant?: 'original' | 'committed' | 'candidate' | 'before_burn';
}

export interface PcResult {
  status: 'COMPUTED' | 'UNVERIFIED';
  value: number | null;
  covariance_basis: string;
  hard_body_radius_m: number;
  hard_body_radius_basis: string;
  miss_distance_m: number;
  method: string;
  policy: string;
  encounter_plane: Record<string, unknown>;
  assumptions: string[];
  reason: string | null;
  inputs: Record<string, unknown>;
}

export interface Conjunction {
  conjunction_id: string;
  primary_id: string;
  secondary_id: string;
  tca: string;
  tca_unix: number;
  miss_distance_km: number;
  relative_speed_kms: number;
  relative_position_teme_km: number[];
  relative_velocity_teme_kms: number[];
  frame: string;
  units: Record<string, string>;
  primary_state_teme: { r_km: number[]; v_kms: number[] };
  secondary_state_teme: { r_km: number[]; v_kms: number[] };
  primary_epoch: string | null;
  secondary_epoch: string | null;
  primary_model: string;
  secondary_model: string;
  coarse_step_s: number;
  coarse_min_distance_km: number;
  refinement: Record<string, unknown>;
  quality: { warnings: string[]; limitations: string[] };
  pc: PcResult | null;
  threat_state: ThreatState;
  threat_rationale: string[];
  rank: number | null;
  secondary_name: string | null;
  secondary_category: string | null;
}

export interface ScreenResponse {
  scenario_id: string;
  primary_id: string;
  conjunctions: Conjunction[];
  stats: Record<string, unknown> & { complete?: boolean; duration_s?: number; candidates_after_altitude_filter?: number };
  co_orbital: { object_id: string; name: string; min_distance_km: number; relative_speed_kms: number; reason: string }[];
  propagation_failures: Record<string, unknown>[];
  overall_threat_state: ThreatState;
  pc_policy: string;
  thresholds: Record<string, unknown>;
}

export interface SecondaryCheckSummary {
  validation_status: 'PASS' | 'FAIL' | 'LIMITED';
  complete: boolean;
  new_conjunctions: number;
  worst_new_state: ThreatState;
  original_encounter: { post_miss_km: number; meets_target: boolean; target_basis: string; post_threat_state: ThreatState };
  limitations: string[];
}

export interface Maneuver {
  maneuver_id: string;
  conjunction_id: string;
  burn_time: string;
  burn_time_unix: number;
  lead_time_s: number;
  lead_orbits: number;
  direction: string;
  direction_label: string;
  dv_rtn_mps: number[];
  dv_teme_mps: number[];
  dv_magnitude_mps: number;
  burn_state_teme: { r_km: number[]; v_pre_kms: number[]; v_post_kms: number[] };
  post_tca: string;
  post_tca_unix: number;
  post_miss_distance_km: number;
  post_relative_speed_kms: number;
  post_relative_position_teme_km: number[];
  post_primary_state_teme: { r_km: number[]; v_kms: number[] };
  post_secondary_state_teme: { r_km: number[]; v_kms: number[] };
  post_pc: PcResult | null;
  post_threat_state: ThreatState;
  post_threat_rationale: string[];
  baseline_miss_distance_km: number;
  screening_miss_distance_km: number;
  miss_distance_change_km: number;
  meets_target: boolean;
  target_basis: string;
  feasible: boolean;
  feasibility_reasons: string[];
  validation_status: 'VALID' | 'REJECTED';
  objective_score: number;
  objective_terms: Record<string, number>;
  propagation_model: string;
  assumptions: string[];
  fuel_proxy: { dv_budget_mps: number; fraction_of_budget: number };
  rank: number | null;
  secondary_check: SecondaryCheckSummary | null;
  /** The primary's version the candidate was planned against; a committed burn bumps it. */
  primary_version?: number | null;
}

export interface PlanResponse {
  scenario_id: string;
  conjunction_id: string;
  candidates: Maneuver[];
  recommended_ids: string[];
  baseline: Record<string, unknown>[];
  config: Record<string, unknown>;
  objective: string;
  assumptions: string[];
  stats: { candidates_evaluated: number; valid: number; meeting_target: number; duration_s: number };
}

export interface SecondaryCheckResponse {
  scenario_id: string;
  maneuver_id: string;
  screened_from: string;
  screened_to: string;
  primary_model: string;
  new_conjunctions: Conjunction[];
  changed_conjunctions: {
    conjunction_id: string;
    secondary_id: string;
    before_miss_km: number;
    after_miss_km: number | null;
    before_tca: string;
    after_tca: string | null;
    before_state: ThreatState;
    after_state: ThreatState;
    status: string;
  }[];
  original_encounter: { post_miss_km: number; meets_target: boolean; target_basis: string; post_threat_state: ThreatState };
  worst_new_state: ThreatState;
  complete: boolean;
  limitations: string[];
  validation_status: 'PASS' | 'FAIL' | 'LIMITED';
  stats: Record<string, unknown>;
  co_orbital: Record<string, unknown>[];
}

export interface ToolCallRecord {
  step: number;
  tool: string;
  arguments: Record<string, unknown>;
  status: 'OK' | 'ERROR' | 'RUNNING';
  started_at: string;
  duration_ms: number;
  summary: string;
  error: string | null;
  result_ref: Record<string, unknown> | null;
}

export interface CompactManeuver {
  maneuver_id: string;
  rank: number | null;
  burn_time: string;
  lead_time_s: number;
  lead_orbits: number;
  direction: string;
  direction_label: string;
  dv_magnitude_mps: number;
  dv_rtn_mps: number[];
  post_miss_distance_km: number;
  post_tca: string;
  post_pc: { status: string; value: number | null; covariance_basis: string; reason?: string | null };
  post_threat_state: ThreatState;
  baseline_miss_distance_km: number;
  meets_target: boolean;
  target_basis: string;
  feasible: boolean;
  feasibility_reasons: string[];
  objective_score: number;
  fuel_proxy: { dv_budget_mps: number; fraction_of_budget: number };
  propagation_model: string;
  secondary_check: SecondaryCheckSummary | null;
}

export interface AgentReport {
  generated_at: string;
  scenario_id: string;
  threat: {
    conjunction_id: string;
    secondary_id: string;
    secondary_name: string | null;
    tca: string;
    miss_distance_km: number;
    relative_speed_kms: number;
    pc: { status: string; value: number | null; covariance_basis: string; reason?: string | null };
    threat_state: ThreatState;
    time_to_tca_s_from_window_start: number;
  };
  threat_summary: string;
  risk_assessment: string;
  risk_basis: string[];
  pc_assumptions: string[];
  maneuvers_considered: CompactManeuver[];
  maneuver_comparison: string;
  secondary_risks: string;
  secondary_checks: Record<string, SecondaryCheckSummary>;
  recommended_maneuver_id: string | null;
  recommended_maneuver: CompactManeuver | null;
  no_action_recommended: boolean;
  recommendation_rationale: string;
  uncertainties: string;
  planner_assumptions: string[];
  thresholds: Record<string, unknown>;
  awaiting_human_decision: boolean;
  note: string;
}

export interface AgentRun {
  run_id: string;
  scenario_id: string;
  provider: 'gemini' | 'deterministic';
  model: string | null;
  status: 'NEEDS_APPROVAL' | 'COMPLETED' | 'INVALID' | 'INCOMPLETE' | 'FAILED' | 'RUNNING';
  started_at: string;
  finished_at: string | null;
  tool_calls: ToolCallRecord[];
  report: AgentReport | null;
  validation: { status: 'VALID' | 'INVALID' | 'PENDING'; checks: { check: string; ok: boolean; detail: string }[] };
  narrative: string;
  warnings: string[];
  simulation: SimulationState;
}

export interface DecisionResponse {
  decision: DecisionRecord;
  maneuver: Maneuver | null;
  secondary_check: SecondaryCheckResponse | null;
  simulation: SimulationState;
}

// ---------------------------------------------------------------- sandbox

export type JunkKind = 'fragment' | 'rocket_body' | 'dead_satellite';

export interface JunkTypeInfo {
  kind: JunkKind;
  category: string;
  label: string;
  blurb: string;
  band_km: [number, number];
  crossing_deg: [number, number];
  radius_m: number;
  relative_speed_kms: [number, number];
  design: SpacecraftDesign;
}

export interface JunkTypesResponse {
  kinds: JunkTypeInfo[];
  min_time_to_tca_s: number;
  max_random_count: number;
  max_objects: number;
}

export interface DesignedEncounter {
  kind: JunkKind;
  tca: string;
  tca_unix: number;
  time_to_tca_s: number;
  miss_km: number;
  miss_horizontal_km: number;
  miss_radial_km: number;
  crossing_angle_deg: number;
  relative_speed_kms: number;
  speed_factor: number;
  seed: number;
  band_km: [number, number];
}

export interface SpawnResponse {
  object: ObjectSummary;
  designed: DesignedEncounter;
  spawned_at: string;
  catalog_version: number;
  events: SimulationEvent[];
  simulation: SimulationState;
}

export interface SpawnBatchResponse {
  objects: ObjectSummary[];
  designed: DesignedEncounter[];
  seed: number;
  catalog_version: number;
  events: SimulationEvent[];
  simulation: SimulationState;
}

export type EvaluateOutcome = 'COMMITTED' | 'AWAITING_APPROVAL' | 'MITIGATED' | 'UNAVOIDABLE' | 'DEFERRED';

export interface EvaluateAction {
  conjunction_id: string;
  secondary_id: string;
  tca: string;
  tca_unix: number;
  miss_km: number;
  threat_state: ThreatState;
  outcome: EvaluateOutcome;
  maneuver_id: string | null;
  post_miss_km: number | null;
  reason: string | null;
  burn_time?: string;
  burn_time_unix?: number;
  direction?: string;
  dv_mps?: number;
}

export interface EvaluateResponse {
  scenario_id: string;
  now: string;
  now_unix: number;
  cached: boolean;
  anchored: number;
  screening: { start: string; end: string; conjunctions_found: number; stats: Record<string, unknown> };
  conjunctions: Conjunction[];
  actions: EvaluateAction[];
  committed_maneuvers: CommittedManeuver[];
  events_added: SimulationEvent[];
  simulation: SimulationState;
}

// ---------------------------------------------------------------- explorer catalog

export type CatalogObjectType = 'PAYLOAD' | 'DEBRIS' | 'ROCKET_BODY';
export type OrbitClass = 'LEO' | 'MEO' | 'GEO' | 'HEO';

export interface CatalogObject {
  norad_id: number;
  name: string;
  type: CatalogObjectType;
  owner: string | null;
  launch_date: string | null;
  intl_designator: string | null;
  orbit_class: OrbitClass;
  inclination_deg: number;
  period_min: number;
  perigee_km: number;
  apogee_km: number;
  epoch: string;
  tle1: string;
  tle2: string;
}

export interface CatalogResponse {
  source: string;
  origin: 'cache' | 'fixture';
  retrieved_at: string | null;
  note: string;
  total: number;
  rejected: number;
  counts_by_type: Record<string, number>;
  objects: CatalogObject[];
}

/** GPM's close approach to one catalog object, from GET /api/catalog/approaches. */
export interface ApproachRecord {
  norad_id: number;
  name: string;
  type: CatalogObjectType;
  tca: string;
  tca_unix: number;
  miss_distance_km: number;
  relative_speed_kms: number;
  /** The simulator's threat state without covariance: UNVERIFIED (inside 10 km) or MONITORING. */
  threat_state: string;
  /** Misses the distance-based mitigation target, so the simulator would plan a burn for it. */
  critical: boolean;
  /** GPM's TEME position at TCA (km). */
  primary_position_teme_km: [number, number, number];
  secondary_position_teme_km: [number, number, number];
}

export interface ApproachesResponse {
  primary_norad_id: number;
  primary_name: string;
  window_start: string;
  window_end: string;
  computed_at: string;
  compute_s: number;
  catalog_retrieved_at: string | null;
  screened: number;
  screening_radius_km: number;
  /** Passes closer than this are critical (the simulator's distance target). */
  critical_distance_km: number;
  /** Approaches still ahead, soonest first. */
  approaches: ApproachRecord[];
  note: string;
}

/** 202 body while the backend is still screening. */
export interface ApproachesPending {
  status: 'computing';
  retry_after_s: number;
}
