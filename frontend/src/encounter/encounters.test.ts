import { describe, expect, it } from 'vitest';
import type { Conjunction, PerceptionSnapshot, ScreenResponse } from '../types/api';
import { buildEncounters, conjunctionToRtn, normalizePerception } from './encounters';

const primaryR = [5529.488, 3905.501, -614.645];
const primaryV = [-3.9, 5.1, 2.9];

function conj(id: string, miss: number, tca: number, state: Conjunction['threat_state'], pc: Conjunction['pc'] = null): Conjunction {
  return {
    conjunction_id: id, primary_id: 'P', secondary_id: 'S', tca: new Date(tca * 1000).toISOString(), tca_unix: tca,
    miss_distance_km: miss, relative_speed_kms: 7.66, relative_position_teme_km: [miss, 0, 0], relative_velocity_teme_kms: [0, 7.66, 0],
    frame: 'TEME', units: {}, primary_state_teme: { r_km: primaryR, v_kms: primaryV },
    secondary_state_teme: { r_km: [primaryR[0] + miss, primaryR[1], primaryR[2]], v_kms: [primaryV[0], primaryV[1] + 7.66, primaryV[2]] },
    primary_epoch: null, secondary_epoch: null, primary_model: 'NUMERICAL_J2', secondary_model: 'NUMERICAL_J2', coarse_step_s: 30,
    coarse_min_distance_km: miss, refinement: {}, quality: { warnings: [], limitations: [] }, pc, threat_state: state, threat_rationale: [],
    rank: 1, secondary_name: 'DEB', secondary_category: 'DEBRIS',
  };
}

const screening = {
  scenario_id: 's', primary_id: 'P', stats: {}, co_orbital: [], propagation_failures: [], overall_threat_state: 'CRITICAL', pc_policy: 'p', thresholds: {},
  conjunctions: [
    conj('c1', 0.354, 10800, 'CRITICAL', { status: 'COMPUTED', value: 5.7e-4, covariance_basis: 'ASSUMED_ILLUSTRATIVE' } as Conjunction['pc']),
    conj('c2', 6.3, 13589, 'MONITORING'), conj('c3', 8.3, 8012, 'MONITORING'), conj('c4', 14.2, 5222, 'MONITORING'),
    conj('c5', 14.9, 16377, 'MONITORING'), conj('c6', 20.9, 19166, 'MONITORING'), conj('c7', 22.9, 2435, 'MONITORING'),
  ],
} as unknown as ScreenResponse;

function perception(objects: PerceptionSnapshot['objects'], kind: 'ORIGINAL' | 'APPROVED' = 'ORIGINAL'): PerceptionSnapshot {
  return {
    scenario_id: 's', primary_id: 'P', primary_variant: { kind, maneuver_id: null, burn_time: null, segments: [] },
    horizon: { start: '', end: '', start_unix: 0, end_unix: 21600, horizon_s: 21600, min_horizon_orbits: 2, primary_period_s: 5578, extends_past_window: false },
    thresholds: { critical_radius_km: 5, tracked_radius_km: 25, horizon_s: 21600, near_field_horizon_s: 1800, ml_watch_threshold: 0.02 },
    tier_rules: [], screening_mode: 'FULL_PHYSICS', objects, counts: {}, model: {} as PerceptionSnapshot['model'], stats: {}, co_orbital: [],
    propagation_failures: [], complete: true, limitations: [], disclaimer: '', cached: false,
  };
}

function pobj(_id: string, tier: 'CRITICAL' | 'SEMI_CRITICAL' | 'ML_WATCH', miss: number | null, tca: number | null, cid: string | null, linked: string | null = null) {
  return {
    object_id: 'S', name: 'DEB', category: 'DEBRIS', tier, rank: 1, ml: { score: 0.2, predicted_tier: 'WATCH', model_version: 'v', basis: 'MODEL_ESTIMATE' },
    physics: {
      status: miss === null ? 'CLEARED' : 'CONJUNCTION', verified: true, conjunction_id: cid, linked_conjunction_id: linked, link_basis: null, tca: null,
      tca_unix: tca, time_to_tca_s: tca, miss_distance_km: miss, relative_speed_kms: 7.66, miss_vector_rtn_km: miss === null ? null : [0.05, -0.303, -0.175],
      relative_velocity_rtn_kms: miss === null ? null : [0, -3.83, 6.63], relative_position_teme_km: null, threat_state: tier === 'CRITICAL' ? 'CRITICAL' : 'MONITORING',
      threat_rationale: [], pc: null, coarse_min_distance_km: null, coarse_min_at: null, models: {}, segment: null,
    },
    trail: null,
  } as PerceptionSnapshot['objects'][number] & { id?: string };
}

describe('buildEncounters', () => {
  it('falls back to screening results with one critical and six semi-critical passes', () => {
    const res = buildEncounters({ perception: null, perceptionManeuvered: null, screening, objects: {}, scenario: null });
    expect(res.basis).toBe('screening');
    expect(res.items.length).toBe(7);
    expect(res.items.filter((i) => i.tier === 'CRITICAL').map((i) => i.id)).toEqual(['c1']);
    expect(res.items[0].offset).not.toBeNull();
    expect(Math.hypot(res.items[0].offset!.x, res.items[0].offset!.y)).toBeCloseTo(0.354, 3);
    expect(res.thresholds).toEqual({ criticalKm: 5, trackedKm: 25, horizonS: 2 * 5578, nearFieldS: 1800 });
  });

  it('prefers the perception snapshot and keeps its tiers and thresholds', () => {
    const p = perception([pobj('a', 'CRITICAL', 0.354, 10800, 'c1'), pobj('b', 'SEMI_CRITICAL', 6.3, 13589, 'c2'), pobj('w', 'ML_WATCH', null, null, null)]);
    const res = buildEncounters({ perception: p, perceptionManeuvered: null, screening, objects: {}, scenario: null });
    expect(res.basis).toBe('perception');
    expect(res.items.map((i) => i.tier)).toEqual(['CRITICAL', 'SEMI_CRITICAL', 'ML_WATCH']);
    expect(res.items[2].offset).toBeNull();
    expect(res.items[0].mlScore).toBe(0.2);
  });

  it('marks the critical encounter mitigated when the maneuvered snapshot clears it', () => {
    const base = perception([pobj('a', 'CRITICAL', 0.354, 10800, 'c1')]);
    const after = perception([pobj('a2', 'SEMI_CRITICAL', 1.458, 10799, 'c1-post', 'c1')], 'APPROVED');
    const res = buildEncounters({ perception: base, perceptionManeuvered: after, screening: null, objects: {}, scenario: null });
    expect(res.items[0].mitigated).toBe(true);
    expect(res.items[0].postMissKm).toBeCloseTo(1.458, 6);
  });

  it('normalises malformed payloads and converts conjunctions to RTN', () => {
    expect(normalizePerception(null)).toBeNull();
    expect(normalizePerception({ objects: 'nope' })!.objects).toEqual([]);
    const { missRtn, vRelRtn } = conjunctionToRtn(screening.conjunctions[0]);
    expect(Math.hypot(...missRtn)).toBeCloseTo(0.354, 6);
    expect(Math.hypot(...vRelRtn)).toBeGreaterThan(7);
  });
});
