import type { Trajectory } from '../types/api';

export type Vec3 = [number, number, number];

/** Cubic Hermite interpolation between two samples (positions km, velocities km/s). */
export function hermite(p0: Vec3, v0: Vec3, p1: Vec3, v1: Vec3, h: number, s: number): { p: Vec3; v: Vec3 } {
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  const d00 = 6 * s2 - 6 * s;
  const d10 = 3 * s2 - 4 * s + 1;
  const d01 = -6 * s2 + 6 * s;
  const d11 = 3 * s2 - 2 * s;
  const p: Vec3 = [0, 0, 0];
  const v: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    p[i] = h00 * p0[i] + h10 * h * v0[i] + h01 * p1[i] + h11 * h * v1[i];
    v[i] = (d00 * p0[i] + d10 * h * v0[i] + d01 * p1[i] + d11 * h * v1[i]) / h;
  }
  return { p, v };
}

/**
 * Precomputed trajectory samples (TEME, km) with Hermite interpolation between
 * them. Samples with missing positions (propagation failures) are skipped.
 */
export class SampledTrajectory {
  readonly objectId: string;
  readonly times: Float64Array;
  readonly positions: Float64Array; // flat xyz
  readonly velocities: Float64Array;
  readonly start: number;
  readonly end: number;
  readonly model: string;
  readonly burnTimeUnix: number | null;

  constructor(traj: Trajectory) {
    this.objectId = traj.object_id;
    this.model = traj.model;
    this.burnTimeUnix = traj.burn_time ? new Date(traj.burn_time).getTime() / 1000 : null;
    const n = traj.times_unix.length;
    const times: number[] = [];
    const pos: number[] = [];
    const vel: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = traj.positions_km[i];
      const v = traj.velocities_kms[i];
      if (!p || !v || p[0] === null || p[1] === null || p[2] === null || v[0] === null || v[1] === null || v[2] === null) continue;
      times.push(traj.times_unix[i]);
      pos.push(p[0], p[1], p[2]);
      vel.push(v[0], v[1], v[2]);
    }
    this.times = Float64Array.from(times);
    this.positions = Float64Array.from(pos);
    this.velocities = Float64Array.from(vel);
    this.start = this.times.length ? this.times[0] : NaN;
    this.end = this.times.length ? this.times[this.times.length - 1] : NaN;
  }

  get length(): number {
    return this.times.length;
  }

  has(t: number): boolean {
    return this.times.length > 0 && t >= this.start && t <= this.end;
  }

  /** Index of the last sample with time <= t (binary search). */
  indexBefore(t: number): number {
    let lo = 0;
    let hi = this.times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.times[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  sampleAt(i: number): { p: Vec3; v: Vec3 } {
    const k = i * 3;
    return {
      p: [this.positions[k], this.positions[k + 1], this.positions[k + 2]],
      v: [this.velocities[k], this.velocities[k + 1], this.velocities[k + 2]],
    };
  }

  stateAt(t: number): { p: Vec3; v: Vec3 } | null {
    if (!this.has(t)) return null;
    const i = this.indexBefore(t);
    if (i >= this.times.length - 1) return this.sampleAt(this.times.length - 1);
    const t0 = this.times[i];
    const t1 = this.times[i + 1];
    const h = t1 - t0;
    if (h <= 0) return this.sampleAt(i);
    const s = (t - t0) / h;
    const a = this.sampleAt(i);
    const b = this.sampleAt(i + 1);
    return hermite(a.p, a.v, b.p, b.v, h, s);
  }

  positionAt(t: number): Vec3 | null {
    const st = this.stateAt(t);
    return st ? st.p : null;
  }

  /** Sample points between two times (inclusive of the interpolated end points). */
  pointsBetween(t0: number, t1: number, maxPoints = 2000): { t: number; p: Vec3 }[] {
    if (!this.times.length) return [];
    const a = Math.max(t0, this.start);
    const b = Math.min(t1, this.end);
    if (b <= a) return [];
    const out: { t: number; p: Vec3 }[] = [];
    const first = this.stateAt(a);
    if (first) out.push({ t: a, p: first.p });
    let i = this.indexBefore(a) + 1;
    const stride = Math.max(1, Math.ceil((this.indexBefore(b) - i) / maxPoints));
    for (; i < this.times.length && this.times[i] < b; i += stride) {
      out.push({ t: this.times[i], p: this.sampleAt(i).p });
    }
    const last = this.stateAt(b);
    if (last) out.push({ t: b, p: last.p });
    return out;
  }
}
