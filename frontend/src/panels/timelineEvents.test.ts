import { describe, expect, it } from 'vitest';
import type { CommittedManeuver, Conjunction } from '../types/api';
import { efficiency, nextEvent, radiusEntryUnix, timelineEvents } from './timelineEvents';

const conj = (p: Partial<Conjunction>): Conjunction =>
  ({ conjunction_id: 'C', secondary_id: 'S', secondary_name: 'S', tca_unix: 1000, miss_distance_km: 1, relative_speed_kms: 10, threat_state: 'MONITORING', ...p }) as Conjunction;
const burn = (p: Partial<CommittedManeuver>): CommittedManeuver =>
  ({ maneuver_id: 'M', conjunction_id: 'C', burn_time_unix: 500, dv_magnitude_mps: 0.05, direction: '-T', direction_label: 'retrograde', source: 'human', fired: false,
    screening_miss_distance_km: 0.354, post_miss_distance_km: 1.4, post_tca_unix: 1000, post_threat_state: 'MONITORING', meets_target: true, ...p }) as CommittedManeuver;

describe('radiusEntryUnix', () => {
  it('is when straight-line relative motion crosses into the radius before TCA', () => {
    // miss 7 km, radius 25 km: sqrt(625 - 49) = 24 km of approach at 8 km/s = 3 s before TCA
    expect(radiusEntryUnix(1000, 7, 8, 25)).toBeCloseTo(997, 6);
  });

  it('falls back to the TCA without a relative speed or for a pass outside the radius', () => {
    expect(radiusEntryUnix(1000, 7, 0, 25)).toBe(1000);
    expect(radiusEntryUnix(1000, 30, 8, 25)).toBe(1000);
  });
});

describe('timelineEvents', () => {
  it('orders detections and burns in time, with each detection at its radius entry', () => {
    const events = timelineEvents(
      [conj({ conjunction_id: 'A', tca_unix: 2000, miss_distance_km: 0.354, relative_speed_kms: 8.2, threat_state: 'CRITICAL', secondary_name: 'DEB-2047' }),
        conj({ conjunction_id: 'B', tca_unix: 900, miss_distance_km: 12 })],
      [burn({ maneuver_id: 'M1', burn_time_unix: 1500, conjunction_id: 'A', post_tca_unix: 2000 })],
      25,
    );
    expect(events.map((e) => e.kind)).toEqual(['detection', 'burn', 'detection']);
    const crit = events[2];
    expect(crit.kind === 'detection' && crit.state).toBe('CRITICAL');
    expect(crit.t).toBeCloseTo(2000 - Math.sqrt(625 - 0.354 ** 2) / 8.2, 6);
    expect(events[1]).toMatchObject({ kind: 'burn', maneuverId: 'M1', t: 1500, dvMps: 0.05 });
  });
});

describe('nextEvent', () => {
  const events = timelineEvents([conj({ tca_unix: 2000 })], [burn({ burn_time_unix: 1500 })], 25);

  it('is the first event after the clock', () => {
    expect(nextEvent(events, 1000)?.kind).toBe('burn');
    expect(nextEvent(events, 1600)?.kind).toBe('detection');
  });

  it('is null once every event is behind the clock', () => {
    expect(nextEvent(events, 3000)).toBeNull();
  });
});

describe('efficiency', () => {
  it('counts passes, objects, critical passes left and dodges with their total delta-v', () => {
    const e = efficiency(
      [conj({ conjunction_id: 'A', secondary_id: 'X', threat_state: 'CRITICAL' }), conj({ conjunction_id: 'B', secondary_id: 'X' }),
        conj({ conjunction_id: 'C', secondary_id: 'Y', threat_state: 'MONITORING' })],
      [burn({ dv_magnitude_mps: 0.05 }), burn({ maneuver_id: 'M2', dv_magnitude_mps: 0.2, screening_miss_distance_km: 0.419, post_miss_distance_km: 0.994 })],
    );
    expect(e).toEqual({ passes: 3, objects: 2, criticalLeft: 1, dodged: 2, totalDvMps: 0.25, closestBeforeKm: 0.354, closestAfterKm: 0.994 });
  });

  it('counts only burns that meet the target as dodges', () => {
    expect(efficiency([], [burn({ meets_target: false })]).dodged).toBe(0);
    expect(efficiency([], []).closestBeforeKm).toBeNull();
  });
});

describe('dodged passes', () => {
  it('keeps the mark of a pass a committed burn dodged, after screening stops calling it critical', () => {
    const events = timelineEvents(
      // ids embed the rounded TCA, so the re-screened pass has a new id but the same object part
      [conj({ conjunction_id: 'CJ-P-X-2001', tca_unix: 2001, miss_distance_km: 1.4, threat_state: 'MONITORING' }), conj({ conjunction_id: 'CJ-P-Y-3000', tca_unix: 3000 })],
      [burn({ conjunction_id: 'CJ-P-X-2000', burn_time_unix: 500, post_tca_unix: 2000, post_miss_distance_km: 1.4 })],
    );
    const dets = events.filter((e) => e.kind === 'detection');
    expect(dets.map((e) => e.kind === 'detection' && e.dodged)).toEqual([true, false]);
  });

  it("does not mark another object's pass that happens to come at the same time", () => {
    const events = timelineEvents(
      [conj({ conjunction_id: 'CJ-P-X-2000', tca_unix: 2000 }), conj({ conjunction_id: 'CJ-P-Z-2001', tca_unix: 2001 })],
      [burn({ conjunction_id: 'CJ-P-X-2000', post_tca_unix: 2000 })],
    );
    expect(events.filter((e) => e.kind === 'detection').map((e) => e.kind === 'detection' && [e.conjunctionId, e.dodged])).toEqual([
      ['CJ-P-X-2000', true],
      ['CJ-P-Z-2001', false],
    ]);
  });

  it('still marks a dodged pass the burn moved out of the radius entirely', () => {
    const events = timelineEvents([], [burn({ burn_time_unix: 500, post_tca_unix: 2000, post_miss_distance_km: 30 })]);
    expect(events.find((e) => e.kind === 'detection')).toMatchObject({ t: 2000, dodged: true, missKm: 30 });
  });
});
