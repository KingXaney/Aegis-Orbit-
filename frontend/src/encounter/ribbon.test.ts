import { describe, expect, it } from 'vitest';
import { SampledTrajectory } from '../simulation/trajectory';
import type { Trajectory } from '../types/api';
import { chaseRibbonPoints, lateralDisplacementAt, ribbonProfile, sampleProfile } from './ribbon';

const MU = 398600.4418;

function circularTrajectory(a: number, phaseShiftKm: number, step: number, n: number, burnTime: number | null): Trajectory {
  const w = Math.sqrt(MU / a ** 3);
  const dphi = phaseShiftKm / a;
  const times: number[] = [];
  const positions: number[][] = [];
  const velocities: number[][] = [];
  for (let i = 0; i < n; i++) {
    const t = i * step;
    const phi = w * t + (burnTime !== null && t >= burnTime ? dphi : 0);
    times.push(t);
    positions.push([a * Math.cos(phi), a * Math.sin(phi), 0]);
    velocities.push([-a * w * Math.sin(phi), a * w * Math.cos(phi), 0]);
  }
  return {
    object_id: 'P', scenario_id: 's', frame: 'TEME', units: {}, model: 't', position_basis: 't', source_epoch: null, start: '', end: '',
    step_s: step, times_unix: times, positions_km: positions, velocities_kms: velocities, status: 'OK', messages: [], segments: [],
    maneuver_id: burnTime !== null ? 'MV' : null, burn_time: burnTime !== null ? new Date(burnTime * 1000).toISOString() : null,
  };
}

describe('ribbon', () => {
  const a = 6798.137;
  const original = new SampledTrajectory(circularTrajectory(a, 0, 60, 200, null));
  const shifted = new SampledTrajectory(circularTrajectory(a, 1.0, 60, 200, 3600));
  // lateral axis at 30 degrees from along-track (a 60-degree crossing): T.L = cos 30
  const basis = { L: [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)] as [number, number, number], U: [1, 0, 0] as [number, number, number] };

  it('projects an along-track phase shift onto the encounter plane', () => {
    const d = lateralDisplacementAt(original, shifted, basis, 7200);
    expect(Math.abs(d.x)).toBeCloseTo(Math.cos(Math.PI / 6) * 1.0, 3);
    expect(Math.abs(d.y)).toBeLessThan(1e-3);
  });

  it('is zero before the burn and without a maneuver', () => {
    expect(lateralDisplacementAt(original, shifted, basis, 1800)).toEqual({ x: 0, y: 0 });
    expect(lateralDisplacementAt(original, null, basis, 7200)).toEqual({ x: 0, y: 0 });
  });

  it('builds a sampled profile that interpolates in time', () => {
    const prof = ribbonProfile(original, shifted, basis, 0, 7200, 60);
    expect(prof.length % 3).toBe(0);
    expect(sampleProfile(prof, 0).x).toBe(0);
    expect(Math.abs(sampleProfile(prof, 7000).x)).toBeCloseTo(Math.cos(Math.PI / 6), 2);
    expect(Math.abs(sampleProfile(prof, 99999).x)).toBeCloseTo(Math.cos(Math.PI / 6), 2);
  });

  it('reproduces the post-burn miss from the baseline miss and the displacement', () => {
    // synthetic design: baseline miss (0.35, 0.05); the -T burn moves the primary by -1.087 km along L, +0.178 radially
    const x = 0.35 - -1.087;
    const y = 0.05 - 0.178;
    expect(Math.abs(Math.hypot(x, y) - 1.458) / 1.458).toBeLessThan(0.02); // wiki figures are rounded
  });

  it('gives the orbit arc ahead in the current RTN frame', () => {
    const pts = chaseRibbonPoints(original, 600, 60, 2);
    expect(pts.length).toBe(31);
    expect(pts[0][0]).toBeCloseTo(0, 9);
    const v = Math.sqrt(MU / a);
    expect(pts[30][1]).toBeCloseTo(v * 60, 0); // along-track distance in 60 s
    expect(pts[30][0]).toBeLessThan(0); // the arc dips below the local horizontal
    expect(Math.abs(pts[30][0])).toBeCloseTo((v * 60) ** 2 / (2 * a), 1);
  });
});
