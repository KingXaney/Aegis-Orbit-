import type { ObjectSummary, ScreenResponse, ThreatState } from '../types/api';

// Shapes of the perception endpoints the ML funnel uses (backend/app/perception/perception.py,
// simulation/service.py catalog_tles, simulation/drill.py). Only the fields the funnel reads are typed.

export interface ShortlistInfo {
  catalog_total: number;
  ml_top_k: number;
  band_margin_km: number;
  band_count: number;
  ml_flagged: number;
  threshold: number;
  model_version: string | null;
  scored_at: string;
  score_duration_s: number;
  basis: string;
  size?: number;
}

export interface PerceptionFunnel {
  tracked: number;
  ml_scored: number;
  ml_flagged: number;
  flagged_ids: string[];
  threshold: number | null;
  screened: number;
  screened_ids: string[];
  passes: number;
  confirmed_ids: string[];
  critical_ids: string[];
  shortlist: ShortlistInfo | null;
}

export type PerceptionTier = 'CRITICAL' | 'SEMI_CRITICAL' | 'ML_WATCH' | 'HIDDEN';

export interface PerceptionObject {
  object_id: string;
  name: string;
  category: string;
  tier: PerceptionTier;
  rank: number;
  ml: { score: number | null; predicted_tier: 'WATCH' | 'CLEAR' | null; basis: string };
  physics: {
    status: string;
    verified: boolean;
    conjunction_id: string | null;
    linked_conjunction_id: string | null;
    tca: string | null;
    tca_unix: number | null;
    miss_distance_km: number | null;
    relative_speed_kms: number | null;
    threat_state: ThreatState | null;
    pc: { status: string; value: number | null } | null;
  };
}

export interface PerceptionResponse {
  scenario_id: string;
  primary_id: string;
  screening_mode: 'FULL_PHYSICS' | 'ML_PRIORITISED';
  objects: PerceptionObject[];
  counts: Record<string, number>;
  funnel: PerceptionFunnel | null;
  thresholds: Record<string, number | string | boolean | null> & { critical_radius_km: number; tracked_radius_km: number };
  model: { status: string; library: string | null; model_version: string | null; threshold: number | null };
  stats: { duration_s: number; score_duration_s: number; screen_duration_s: number };
  limitations: string[];
  disclaimer: string;
}

/** [object_id, name, category, line1, line2] */
export type TleRow = [string, string, string, string, string];

export interface CatalogTlesResponse {
  scenario_id: string;
  primary_id: string;
  count: number;
  fields: string[];
  rows: TleRow[];
  source: string | null;
  retrieved_at: string | null;
}

export interface DrillResponse {
  scenario_id: string;
  now: string;
  now_unix: number;
  object: ObjectSummary;
  designed: { tca: string; tca_unix: number; miss_km: number; relative_speed_kms: number; crossing_angle_deg: number };
  screening: ScreenResponse;
}
