import { describe, expect, it } from 'vitest';
import { CONFIRMED, CRITICAL, FLAGGED, SCREENED, STEP, funnelRows, membershipBits, pointStyle, verdictFor } from './funnel';
import type { PerceptionFunnel, PerceptionObject, PerceptionResponse } from './types';

const funnel: PerceptionFunnel = {
  tracked: 6,
  ml_scored: 6,
  ml_flagged: 3,
  flagged_ids: ['a', 'b', 'c'],
  threshold: 0.0236,
  screened: 3,
  screened_ids: ['b', 'c', 'd'],
  passes: 3,
  confirmed_ids: ['c', 'd'],
  critical_ids: ['d'],
  shortlist: { catalog_total: 6, ml_top_k: 2, band_margin_km: 10, band_count: 2, ml_flagged: 3, threshold: 0.0236, model_version: 'v1', scored_at: '', score_duration_s: 0.047, basis: '' },
};

function obj(id: string, tier: PerceptionObject['tier'], missKm: number | null, tcaUnix: number | null): PerceptionObject {
  return {
    object_id: id,
    name: id.toUpperCase(),
    category: 'DEBRIS',
    tier,
    rank: 1,
    ml: { score: 0.5, predicted_tier: 'WATCH', basis: 'MODEL_ESTIMATE' },
    physics: { status: 'CONJUNCTION', verified: true, conjunction_id: `CJ-${id}`, linked_conjunction_id: null, tca: null, tca_unix: tcaUnix, miss_distance_km: missKm, relative_speed_kms: 8, threat_state: 'UNVERIFIED', pc: null },
  };
}

function response(objects: PerceptionObject[]): PerceptionResponse {
  return {
    scenario_id: 'real-iss',
    primary_id: 'NORAD-25544',
    screening_mode: 'ML_PRIORITISED',
    objects,
    counts: {},
    funnel,
    thresholds: { critical_radius_km: 5, tracked_radius_km: 25 },
    model: { status: 'LOADED', library: 'xgboost', model_version: 'v1', threshold: 0.0236 },
    stats: { duration_s: 0.4, score_duration_s: 0.047, screen_duration_s: 0.33 },
    limitations: [],
    disclaimer: '',
  };
}

describe('funnelRows', () => {
  it('reads every count from the backend funnel, in order', () => {
    const rows = funnelRows(funnel, response([]));
    expect(rows.map((r) => [r.key, r.count])).toEqual([['tracked', 6], ['flagged', 3], ['screened', 3], ['confirmed', 3], ['critical', 1]]);
    expect(rows[1].detail).toContain('47 ms');
    expect(rows[2].detail).toContain("model's top 2 + 2 within 10 km");
    expect(rows[3].detail).toContain('inside 25 km · 2 objects');
  });

  it('labels injected drill objects in the tracked count', () => {
    expect(funnelRows(funnel, response([]))[0].detail).not.toContain('drill');
    expect(funnelRows(funnel, response([]), 1)[0].detail).toContain('(+1 injected drill)');
  });

  it('says when the whole catalog was screened', () => {
    expect(funnelRows({ ...funnel, shortlist: null }, response([]))[2].detail).toContain('every object');
  });
});

describe('membershipBits', () => {
  it('marks each object with every stage it reached', () => {
    const bits = membershipBits(['a', 'b', 'c', 'd', 'e'], funnel);
    expect(Array.from(bits)).toEqual([FLAGGED, FLAGGED | SCREENED, FLAGGED | SCREENED | CONFIRMED, SCREENED | CONFIRMED | CRITICAL, 0]);
  });

  it('is all zero without a funnel', () => {
    expect(Array.from(membershipBits(['a'], null))).toEqual([0]);
  });
});

describe('pointStyle', () => {
  it('draws every object alike before and at the tracked step', () => {
    expect(pointStyle(0, STEP.tracked)).toEqual(pointStyle(FLAGGED | SCREENED | CONFIRMED, -1));
  });

  it('lights up only the flagged objects at the flagged step', () => {
    expect(pointStyle(FLAGGED, STEP.flagged)?.role).toBe('flagged');
    expect(pointStyle(SCREENED, STEP.flagged)!.alpha).toBeLessThan(0.1);
  });

  it('shows the physics set, safety-band objects included, at the screened step', () => {
    expect(pointStyle(SCREENED, STEP.screened)?.role).toBe('screened');
    expect(pointStyle(FLAGGED, STEP.screened)!.alpha).toBeLessThan(pointStyle(SCREENED, STEP.screened)!.alpha);
  });

  it('turns critical objects red only at the critical step, and hides points that have an entity', () => {
    const bits = SCREENED | CONFIRMED | CRITICAL;
    expect(pointStyle(bits, STEP.confirmed)?.role).toBe('confirmed');
    expect(pointStyle(bits, STEP.critical)?.role).toBe('critical');
    expect(pointStyle(bits, STEP.critical, true)).toBeNull();
    expect(pointStyle(0, STEP.critical)!.alpha).toBeLessThan(0.05);
  });
});

describe('verdictFor', () => {
  it('recommends staying on course with the closest pass when nothing is critical', () => {
    const v = verdictFor(response([obj('far', 'SEMI_CRITICAL', 12.5, 3), obj('near', 'SEMI_CRITICAL', 6.7, 9), obj('w', 'ML_WATCH', null, null)]));
    expect(v.kind).toBe('stay');
    if (v.kind === 'stay') expect(v.closest?.object_id).toBe('near');
  });

  it('stays on course with no closest pass when nothing came inside the tracked radius', () => {
    const v = verdictFor(response([obj('w', 'ML_WATCH', null, null)]));
    expect(v).toEqual({ kind: 'stay', closest: null, criticalKm: 5 });
  });

  it('alerts on every critical pass, earliest first', () => {
    const v = verdictFor(response([obj('late', 'CRITICAL', 0.4, 200), obj('soon', 'CRITICAL', 2.1, 100), obj('s', 'SEMI_CRITICAL', 6.7, 50)]));
    expect(v.kind).toBe('alert');
    if (v.kind === 'alert') expect(v.threats.map((t) => t.object_id)).toEqual(['soon', 'late']);
  });
});
