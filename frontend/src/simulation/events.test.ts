import { describe, expect, it } from 'vitest';
import { eventWithin, nextEvent, passWithin } from './events';
import type { CommittedManeuver, Conjunction, ScreenResponse } from '../types/api';

function conj(id: string, tca: number, miss: number, state: Conjunction['threat_state'] = 'MONITORING'): Conjunction {
  return { conjunction_id: id, secondary_id: `S-${id}`, secondary_name: `Junk ${id}`, tca_unix: tca, miss_distance_km: miss, threat_state: state } as Conjunction;
}
function screening(...conjunctions: Conjunction[]): ScreenResponse {
  return { conjunctions } as ScreenResponse;
}
function burn(id: string, t: number): CommittedManeuver {
  return { maneuver_id: id, burn_time_unix: t, direction: '-T', dv_magnitude_mps: 0.35 } as CommittedManeuver;
}

describe('nextEvent', () => {
  it('returns null when nothing is ahead', () => {
    expect(nextEvent(null, [], 100)).toBeNull();
    expect(nextEvent(screening(conj('a', 50, 1)), [burn('m', 60)], 100)).toBeNull();
  });

  it('picks the soonest future burn or closest approach', () => {
    const scr = screening(conj('a', 500, 0.4, 'CRITICAL'), conj('b', 300, 12));
    const n = nextEvent(scr, [burn('m', 400)], 100)!;
    expect(n.kind).toBe('tca');
    expect(n.id).toBe('b');
    expect(n.critical).toBe(false);
    expect(n.label).toContain('12.0 km');
    const later = nextEvent(scr, [burn('m', 400)], 350)!;
    expect(later.kind).toBe('burn');
    expect(later.label).toContain('-T 0.35 m/s');
    const last = nextEvent(scr, [burn('m', 400)], 450)!;
    expect(last.id).toBe('a');
    expect(last.critical).toBe(true);
    expect(last.label).toContain('400 m');
  });
});

describe('eventWithin', () => {
  it('finds the nearest burn or close pass and respects the miss limit', () => {
    const scr = screening(conj('far', 1000, 18), conj('near', 1100, 2));
    const burns = [burn('m', 1040)];
    expect(eventWithin(scr, burns, 1030, 60, 10)).toMatchObject({ kind: 'burn', id: 'm' });
    expect(eventWithin(scr, burns, 1095, 60, 10)).toMatchObject({ kind: 'tca', id: 'near', missKm: 2 });
    expect(eventWithin(scr, [], 1000, 60, 10)).toBeNull(); // the 18 km pass is not worth slowing for
    expect(eventWithin(scr, [], 1000, 60)).toMatchObject({ id: 'far' });
    expect(eventWithin(null, null, 1000, 60)).toBeNull();
  });
});

describe('passWithin', () => {
  it('finds the closest approach nearest to now inside the half window', () => {
    const scr = screening(conj('a', 1000, 1), conj('b', 1040, 2));
    expect(passWithin(scr, 1030, 45)?.conjunction_id).toBe('b');
    expect(passWithin(scr, 1010, 45)?.conjunction_id).toBe('a');
    expect(passWithin(scr, 2000, 45)).toBeNull();
    expect(passWithin(null, 1000, 45)).toBeNull();
  });
});
