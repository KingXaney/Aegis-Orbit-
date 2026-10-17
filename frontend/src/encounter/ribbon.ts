import type { SampledTrajectory, Vec3 } from '../simulation/trajectory';
import { dot, rtnBasis, sub, toRtn } from './rtn';

export interface PlaneBasis {
  L: Vec3;
  U: Vec3;
}

export const DEFAULT_PLANE: PlaneBasis = { L: [0, 0, 1], U: [1, 0, 0] };

/** Lateral/radial displacement (km) of the maneuvered trajectory relative to the original at time t. */
export function lateralDisplacementAt(original: SampledTrajectory, maneuvered: SampledTrajectory | null, basis: PlaneBasis, t: number): { x: number; y: number } {
  if (!maneuvered || maneuvered.burnTimeUnix === null || t < maneuvered.burnTimeUnix) return { x: 0, y: 0 };
  const o = original.stateAt(t);
  const m = maneuvered.stateAt(t);
  if (!o || !m) return { x: 0, y: 0 };
  const d = toRtn(sub(m.p, o.p), rtnBasis(o.p, o.v));
  return { x: dot(d, basis.L), y: dot(d, basis.U) };
}

/** (t, x, y) triples every stepS between t0 and t1 (inclusive of t1). */
export function ribbonProfile(original: SampledTrajectory, maneuvered: SampledTrajectory | null, basis: PlaneBasis, t0: number, t1: number, stepS = 30): Float64Array {
  const n = Math.max(2, Math.floor((t1 - t0) / stepS) + 2);
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = Math.min(t0 + i * stepS, t1);
    const { x, y } = lateralDisplacementAt(original, maneuvered, basis, t);
    out[i * 3] = t;
    out[i * 3 + 1] = x;
    out[i * 3 + 2] = y;
  }
  return out;
}

/** Linear interpolation of a profile at time t (clamped to the profile's range). */
export function sampleProfile(profile: Float64Array, t: number): { x: number; y: number } {
  const n = profile.length / 3;
  if (n === 0) return { x: 0, y: 0 };
  if (t <= profile[0]) return { x: profile[1], y: profile[2] };
  const last = (n - 1) * 3;
  if (t >= profile[last]) return { x: profile[last + 1], y: profile[last + 2] };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (profile[mid * 3] <= t) lo = mid;
    else hi = mid;
  }
  const t0 = profile[lo * 3];
  const t1 = profile[hi * 3];
  const s = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  return { x: profile[lo * 3 + 1] + s * (profile[hi * 3 + 1] - profile[lo * 3 + 1]), y: profile[lo * 3 + 2] + s * (profile[hi * 3 + 2] - profile[lo * 3 + 2]) };
}

/** Future satellite positions relative to its current state, in its current RTN frame (km): the road ahead at true scale. */
export function chaseRibbonPoints(sat: SampledTrajectory, nowUnix: number, aheadS = 60, stepS = 2): Vec3[] {
  const s0 = sat.stateAt(nowUnix);
  if (!s0) return [];
  const b = rtnBasis(s0.p, s0.v);
  const out: Vec3[] = [];
  for (let dt = 0; dt <= aheadS + 1e-9; dt += stepS) {
    const s = sat.stateAt(nowUnix + dt);
    if (!s) break;
    out.push(toRtn(sub(s.p, s0.p), b));
  }
  return out;
}
