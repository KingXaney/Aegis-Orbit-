import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, MAP, alongUnits, encounterPlaneOffset, inverseAlong, laneTicks, lateralUnits, objectMapPosition, timeTicks, trailMapOffsets } from './encounterMap';
import type { EncounterItem } from './encounters';
import type { Vec3 } from '../simulation/trajectory';

function item(partial: Partial<EncounterItem>): EncounterItem {
  return {
    id: 'x', objectId: 'o', name: 'o', category: 'DEBRIS', tier: 'CRITICAL', conjunctionId: 'x', tcaUnix: 1000, missKm: 0.354,
    relSpeedKms: 7.66, missRtn: [0.05, -0.303, -0.175], vRelRtn: [0, -3.83, 6.63], offset: null, threatState: 'CRITICAL', pc: null,
    mlScore: null, mlPredicted: null, verified: true, status: 'CONJUNCTION', trail: null, mitigated: false, postMissKm: null, postTier: null,
    ...partial,
  };
}

describe('lateralUnits', () => {
  it('is linear to 3 km, logarithmic to the edge, odd and continuous', () => {
    expect(lateralUnits(0.354)).toBeCloseTo(0.354, 9);
    expect(lateralUnits(1.458)).toBeCloseTo(1.458, 9);
    expect(lateralUnits(3)).toBeCloseTo(3, 9);
    expect(lateralUnits(3.0001)).toBeCloseTo(3, 3);
    expect(lateralUnits(5)).toBeCloseTo(3.72, 2);
    expect(lateralUnits(10)).toBeCloseTo(4.70, 2);
    expect(lateralUnits(25)).toBeCloseTo(6, 9);
    expect(lateralUnits(-10)).toBeCloseTo(-lateralUnits(10), 12);
    expect(lateralUnits(50)).toBeLessThanOrEqual(6.5);
    const xs = [0, 0.5, 1, 2, 3, 4, 8, 15, 25, 40];
    for (let i = 1; i < xs.length; i++) expect(lateralUnits(xs[i])).toBeGreaterThan(lateralUnits(xs[i - 1]));
  });
});

describe('alongUnits', () => {
  it('is linear for ten minutes then logarithmic, continuous and smooth at the joint', () => {
    expect(alongUnits(0)).toBe(0);
    expect(alongUnits(300)).toBeCloseTo(15, 9);
    expect(alongUnits(600)).toBeCloseTo(30, 9);
    expect(alongUnits(10800)).toBeCloseTo(116.7, 1);
    const h = 1e-3;
    const left = (alongUnits(600) - alongUnits(600 - h)) / h;
    const right = (alongUnits(600 + h) - alongUnits(600)) / h;
    expect(Math.abs(left - right)).toBeLessThan(1e-3);
    expect(alongUnits(-3600)).toBe(-MAP.BEHIND_MAX_UNITS);
    for (const tau of [10, 600, 601, 5000, 20000]) expect(inverseAlong(alongUnits(tau))).toBeCloseTo(tau, 6);
  });
});

describe('encounterPlaneOffset', () => {
  it('recovers the designed synthetic miss (0.35 km horizontal, 0.05 km radial)', () => {
    const w: Vec3 = [0, -3.83, 6.63];
    const { x, y, along } = encounterPlaneOffset([0.05, -0.303, -0.175], w);
    expect(Math.hypot(x, y)).toBeCloseTo(0.3535, 3);
    expect(Math.abs(y - 0.05)).toBeLessThan(2e-3);
    expect(Math.abs(Math.abs(x) - 0.35)).toBeLessThan(2e-3);
    expect(Math.abs(along)).toBeLessThan(2e-3);
  });

  it('falls back to the cross-track axis when the relative velocity is radial', () => {
    const { L } = encounterPlaneOffset([0, 1, 0], [1, 0, 0]);
    expect(L).toEqual([0, 0, 1]);
  });
});

describe('objectMapPosition', () => {
  const thr = { ...DEFAULT_THRESHOLDS, horizonS: 21600 };
  const base = item({ tcaUnix: 10000, offset: { x: 0.35, y: 0.05, L: [0, 0, 1], U: [1, 0, 0] } });

  it('puts the object at the satellite at TCA and ahead before it', () => {
    const at = objectMapPosition(base, 10000, thr);
    expect(at.z).toBeCloseTo(0, 9);
    expect(at.x).toBeCloseTo(0.35, 9);
    expect(at.visible).toBe(true);
    const before = objectMapPosition(base, 10000 - 300, thr);
    expect(before.z).toBeCloseTo(-15, 9);
  });

  it('fades after the encounter and hides beyond the fade window', () => {
    expect(objectMapPosition(base, 10000 + 30, thr).opacity).toBe(1);
    expect(objectMapPosition(base, 10000 + 120, thr).opacity).toBeCloseTo(0.5, 9);
    expect(objectMapPosition(base, 10000 + 200, thr).visible).toBe(false);
  });

  it('applies the near-field horizon to non-critical tiers only', () => {
    const semi = item({ ...base, tier: 'SEMI_CRITICAL' });
    expect(objectMapPosition(semi, 10000 - 3600, thr).visible).toBe(false);
    expect(objectMapPosition(semi, 10000 - 1000, thr).visible).toBe(true);
    expect(objectMapPosition(base, 10000 - 3600, thr).visible).toBe(true);
    expect(objectMapPosition(base, 10000 - 30000, thr).visible).toBe(false);
  });

  it('is invisible without a TCA', () => {
    expect(objectMapPosition(item({ tcaUnix: null }), 0, thr).visible).toBe(false);
  });
});

describe('ticks and trails', () => {
  it('produces symmetric lane ticks with the critical and edge lines', () => {
    const ticks = laneTicks(DEFAULT_THRESHOLDS);
    expect(ticks.filter((t) => t.kind === 'critical').map((t) => t.km).sort()).toEqual([-5, 5]);
    expect(ticks.find((t) => t.kind === 'edge' && t.km > 0)?.u).toBeCloseTo(6, 9);
    expect(timeTicks(21600).map((t) => t.label)).toContain('T−1 h');
    expect(timeTicks(600).length).toBe(4);
  });

  it('scales trail samples relative to the box and crosses the road', () => {
    const it0 = item({
      offset: { x: 0.35, y: 0.05, L: [0, 0, 1], U: [1, 0, 0] },
      trail: { timesUnix: [0, 1, 2], rtnKm: [[0.05, -0.303 + 3.83 * 5, -0.175 - 6.63 * 5], [0.05, -0.303, -0.175], [0.05, -0.303 - 3.83 * 5, -0.175 + 6.63 * 5]] },
    });
    const off = trailMapOffsets(it0);
    expect(off.length).toBe(9);
    expect(off[3]).toBeCloseTo(0, 9);
    expect(off[4]).toBeCloseTo(0, 9);
    expect(off[5]).toBeCloseTo(0, 9);
    expect(Math.abs(off[0])).toBeCloseTo((8 / 690) * 6.63 * 5, 6);
    expect(Math.abs(off[2])).toBeCloseTo((8 / 690) * 3.83 * 5, 6);
  });
});
