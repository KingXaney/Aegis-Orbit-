// Mirrors backend/app/schemas/models.py. All timestamps are ISO 8601 UTC strings;
// positions are km in the TEME frame; velocities km/s; delta-v m/s.

export type ThreatState = 'NORMAL' | 'MONITORING' | 'ELEVATED' | 'CRITICAL' | 'MITIGATED' | 'UNVERIFIED';

export interface HealthResponse {
  status: string;
  version: string;
  agent_mode: string;
  gemini_configured: boolean;
  network_allowed: boolean;
  scenarios: string[];
  disclaimer: string;
}

export interface ScenarioSummary {
  scenario_id: string;
  name: string;
  kind: 'real' | 'synthetic';
}

export interface Window {
  start: string;
  end: string;
  start_unix: number;
  end_unix: number;
}

export interface DecisionRecord {
  decision_id: string;
  type: 'APPROVED' | 'REJECTED';
  maneuver_id: string;
  conjunction_id: string | null;
  at: string;
  reason: string | null;
  note: string;
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
  note: string;
}

export interface ScenarioDetail {
  scenario_id: string;
  name: string;
  kind: 'real' | 'synthetic';
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

// ---- Perception layer (ML-ranked, physics-verified objects around the primary) ----

export type PerceptionTier = 'CRITICAL' | 'SEMI_CRITICAL' | 'ML_WATCH' | 'HIDDEN';

export interface PerceptionML {
  score: number | null;
  predicted_tier: string | null;
  model_version: string | null;
  basis: string;
  note?: string | null;
  elements_basis?: string | null;
}

export interface PerceptionTrail {
  frame: string;
  center_unix: number;
  step_s: number;
  times_unix: number[];
  positions_rtn_km: number[][];
  basis: string;
}

export interface PerceptionPhysics {
  status: string;
  verified: boolean;
  conjunction_id: string | null;
  linked_conjunction_id: string | null;
  link_basis: string | null;
  clearance?: string | null;
  tca: string | null;
  tca_unix: number | null;
  time_to_tca_s: number | null;
  miss_distance_km: number | null;
  relative_speed_kms: number | null;
  miss_vector_rtn_km: number[] | null;
  relative_velocity_rtn_kms: number[] | null;
  relative_position_teme_km: number[] | null;
  threat_state: ThreatState | null;
  threat_rationale: string[];
  pc: { status: string; value: number | null; covariance_basis: string; reason?: string | null } | null;
  coarse_min_distance_km: number | null;
  coarse_min_at: string | null;
  models: Record<string, string | null>;
  segment: string | null;
}

export interface PerceptionObject {
  object_id: string;
  name: string;
  category: string;
  tier: PerceptionTier;
  rank: number;
  ml: PerceptionML;
  physics: PerceptionPhysics;
  trail: PerceptionTrail | null;
}

export interface PerceptionModelInfo {
  status: 'LOADED' | 'UNAVAILABLE';
  library: string | null;
  library_version: string | null;
  model_version: string | null;
  artifact: string | null;
  feature_version: number;
  feature_names: string[];
  trained_at: string | null;
  data_retrieved_at: Record<string, string>;
  training: Record<string, unknown>;
  metrics: Record<string, unknown>;
  feature_importance: Record<string, number>;
  threshold: number | null;
  threshold_basis: string | null;
  artifacts: Record<string, unknown>;
  reason: string | null;
  basis: string;
}

export interface PerceptionSnapshot {
  scenario_id: string;
  primary_id: string;
  primary_variant: { kind: 'ORIGINAL' | 'CANDIDATE' | 'APPROVED'; maneuver_id: string | null; burn_time: string | null; segments: Record<string, unknown>[] };
  horizon: { start: string; end: string; start_unix: number; end_unix: number; horizon_s: number; min_horizon_orbits: number; primary_period_s: number; extends_past_window: boolean };
  thresholds: { critical_radius_km: number; tracked_radius_km: number; horizon_s: number; near_field_horizon_s: number; ml_watch_threshold: number | null } & Record<string, unknown>;
  tier_rules: string[];
  screening_mode: string;
  objects: PerceptionObject[];
  counts: Record<string, number>;
  model: PerceptionModelInfo;
  stats: Record<string, unknown>;
  co_orbital: Record<string, unknown>[];
  propagation_failures: Record<string, unknown>[];
  complete: boolean;
  limitations: string[];
  disclaimer: string;
  cached: boolean;
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
