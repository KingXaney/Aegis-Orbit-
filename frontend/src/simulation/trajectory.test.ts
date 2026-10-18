import { describe, expect, it } from 'vitest';
import { SampledTrajectory, hermite } from './trajectory';
import type { Trajectory } from '../types/api';

const MU = 398600.4418;

function circular(a: number, step: number, n: number): Trajectory {
  const w = Math.sqrt(MU / a ** 3);
  const times: number[] = [];
  const positions: number[][] = [];
  const velocities: number[][] = [];
  for (let i = 0; i < n; i++) {
    const t = i * step;
    times.push(t);
    positions.push([a * Math.cos(w * t), a * Math.sin(w * t), 0]);
    velocities.push([-a * w * Math.sin(w * t), a * w * Math.cos(w * t), 0]);
  }
  return {
    object_id: 'X', scenario_id: 's', frame: 'TEME', units: {}, model: 'test', position_basis: 'test', source_epoch: null,
    start: '', end: '', step_s: step, times_unix: times, positions_km: positions, velocities_kms: velocities,
    status: 'OK', messages: [], segments: [], maneuver_id: null, burn_time: null,
  };
}

describe('hermite', () => {
  it('reproduces the end points', () => {
    const r = hermite([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], 1, 0);
    expect(r.p).toEqual([0, 0, 0]);
    const e = hermite([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], 1, 1);
    expect(e.p[0]).toBeCloseTo(1);
    expect(e.p[1]).toBeCloseTo(1);
  });
});

describe('SampledTrajectory', () => {
  const a = 6798;
  const traj = new SampledTrajectory(circular(a, 60, 100));
  const w = Math.sqrt(MU / a ** 3);

  it('interpolates a circular orbit to sub-metre accuracy between 60 s samples', () => {
    for (const t of [30, 90.5, 1234.567, 5000]) {
      const st = traj.stateAt(t)!;
      const exact = [a * Math.cos(w * t), a * Math.sin(w * t), 0];
      const err = Math.hypot(st.p[0] - exact[0], st.p[1] - exact[1], st.p[2] - exact[2]);
      expect(err).toBeLessThan(0.001); // 1 m
      const vExact = [-a * w * Math.sin(w * t), a * w * Math.cos(w * t), 0];
      expect(Math.hypot(st.v[0] - vExact[0], st.v[1] - vExact[1])).toBeLessThan(1e-4);
    }
  });

  it('returns null outside the sampled range and exact samples at nodes', () => {
    expect(traj.stateAt(-1)).toBeNull();
    expect(traj.stateAt(99 * 60 + 1)).toBeNull();
    expect(traj.stateAt(600)!.p[0]).toBeCloseTo(a * Math.cos(w * 600), 9);
  });

  it('lists points between two times at the native step, with exact ends', () => {
    const pts = traj.pointsBetween(45, 200);
    expect(pts[0].t).toBe(45);
    expect(pts[pts.length - 1].t).toBe(200);
    expect(pts.map((p) => p.t)).toEqual([45, 105, 165, 200]);
  });

  it('resamples at a requested step so consecutive chords bend by less than a degree', () => {
    const pts = traj.pointsBetween(0, 2800, { stepS: 7 });
    expect(pts.length).toBe(401);
    expect(pts[0].t).toBe(0);
    expect(pts[pts.length - 1].t).toBe(2800);
    let worstDeg = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const u = [pts[i].p[0] - pts[i - 1].p[0], pts[i].p[1] - pts[i - 1].p[1], pts[i].p[2] - pts[i - 1].p[2]];
      const v = [pts[i + 1].p[0] - pts[i].p[0], pts[i + 1].p[1] - pts[i].p[1], pts[i + 1].p[2] - pts[i].p[2]];
      const cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v));
      worstDeg = Math.max(worstDeg, (Math.acos(Math.min(1, cos)) * 180) / Math.PI);
    }
    expect(worstDeg).toBeLessThan(0.6);
    for (const pt of pts) {
      const exact = [a * Math.cos(w * pt.t), a * Math.sin(w * pt.t), 0];
      expect(Math.hypot(pt.p[0] - exact[0], pt.p[1] - exact[1], pt.p[2] - exact[2])).toBeLessThan(0.001);
    }
  });

  it('never returns more than maxPoints', () => {
    const pts = traj.pointsBetween(0, 5000, { stepS: 1, maxPoints: 100 });
    expect(pts.length).toBeLessThanOrEqual(100);
    expect(pts[0].t).toBe(0);
    expect(pts[pts.length - 1].t).toBe(5000);
  });

  it('clips the span to the sampled range', () => {
    expect(traj.pointsBetween(-100, -50)).toEqual([]);
    const pts = traj.pointsBetween(-100, 30, { stepS: 10 });
    expect(pts[0].t).toBe(0);
    expect(pts[pts.length - 1].t).toBe(30);
  });

  it('skips samples with missing positions', () => {
    const t = circular(a, 60, 5);
    t.positions_km[2] = [null, null, null];
    const s = new SampledTrajectory(t);
    expect(s.length).toBe(4);
  });
});
