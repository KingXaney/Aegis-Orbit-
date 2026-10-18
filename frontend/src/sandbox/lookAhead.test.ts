import { describe, expect, it } from 'vitest';
import type { CommittedManeuver, Conjunction, ScreenResponse } from '../types/api';
import { LOOK_AHEAD_S, offsetLabel, passTone, railMarkers, screenedUntil } from './lookAhead';

const conj = (id: string, tca: number, missKm: number, state: Conjunction['threat_state']) =>
  ({ conjunction_id: id, tca_unix: tca, miss_distance_km: missKm, threat_state: state, secondary_id: id, secondary_name: `Junk ${id}` }) as Conjunction;
const screening = (cs: Conjunction[]) => ({ conjunctions: cs }) as unknown as ScreenResponse;
const burn = (id: string, t: number) => ({ maneuver_id: id, burn_time_unix: t, direction: '-T', dv_magnitude_mps: 0.5 }) as CommittedManeuver;

describe('railMarkers', () => {
  const now = 1000;

  it('places passes, burns and ghosts inside the horizon only', () => {
    const ms = railMarkers(
      screening([conj('a', now + LOOK_AHEAD_S / 2, 1, 'CRITICAL'), conj('past', now - 10, 1, 'CRITICAL'), conj('far', now + LOOK_AHEAD_S + 1, 1, 'CRITICAL')]),
      [burn('b', now + 600)],
      [{ id: 'ghost:g', atUnix: now + 1200, missKm: 0.1, label: 'ghost meets x' }],
      now,
    );
    expect(ms.map((m) => m.id)).toEqual(['a', 'b', 'ghost:g']);
    expect(ms[0].x).toBeCloseTo(0.5);
  });

  it('draws closer passes taller and keeps a stub at the radius', () => {
    const [near, far] = railMarkers(screening([conj('near', now + 100, 0.1, 'CRITICAL'), conj('far', now + 200, 30, 'NORMAL')]), [], [], now);
    expect(near.kind === 'pass' && near.height).toBeGreaterThan(0.9);
    expect(far.kind === 'pass' && far.height).toBeCloseTo(0.25);
  });
});

describe('passTone', () => {
  it('reads threat, watch and clear from the threat state', () => {
    expect(passTone('ELEVATED')).toBe('threat');
    expect(passTone('MONITORING')).toBe('watch');
    expect(passTone('MITIGATED')).toBe('clear');
  });
});

describe('screenedUntil', () => {
  it('is null when the screening reaches past the rail', () => {
    expect(screenedUntil(null, 0)).toBeNull();
    expect(screenedUntil(LOOK_AHEAD_S + 5, 0)).toBeNull();
    expect(screenedUntil(LOOK_AHEAD_S / 4, 0)).toBeCloseTo(0.25);
  });
});

describe('offsetLabel', () => {
  it('labels ticks from now', () => {
    expect(offsetLabel(0)).toBe('now');
    expect(offsetLabel(1800)).toBe('+30m');
    expect(offsetLabel(3600)).toBe('+1h');
    expect(offsetLabel(5400)).toBe('+1h30');
  });
});
