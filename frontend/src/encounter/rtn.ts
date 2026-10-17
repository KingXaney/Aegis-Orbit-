import type { Vec3 } from '../simulation/trajectory';

/** Radial / along-track / cross-track basis of a TEME state (same convention as backend frames.rtn_basis). */
export interface RtnBasis {
  r: Vec3;
  t: Vec3;
  n: Vec3;
}

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: Vec3): number => Math.sqrt(dot(a, a));
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  return n > 0 ? scale(a, 1 / n) : [0, 0, 0];
}

export function rtnBasis(p: Vec3, v: Vec3): RtnBasis {
  const r = normalize(p);
  const n = normalize(cross(p, v));
  const t = cross(n, r);
  return { r, t, n };
}

export function toRtn(vec: Vec3, b: RtnBasis): Vec3 {
  return [dot(vec, b.r), dot(vec, b.t), dot(vec, b.n)];
}

/**
 * Relative position and co-moving relative velocity of `other` seen from `primary`,
 * in the primary's RTN frame (km, km/s). The frame rotates at omega = (p x v)/|p|^2,
 * so the transport term omega x r_rel is removed from the inertial velocity difference.
 */
export function relativeStateRtn(primary: { p: Vec3; v: Vec3 }, other: { p: Vec3; v: Vec3 }): { r: Vec3; v: Vec3 } {
  const rel = sub(other.p, primary.p);
  const omega = scale(cross(primary.p, primary.v), 1 / dot(primary.p, primary.p));
  const vRel = sub(sub(other.v, primary.v), cross(omega, rel));
  const b = rtnBasis(primary.p, primary.v);
  return { r: toRtn(rel, b), v: toRtn(vRel, b) };
}

/** Three.js world axes: x = -N (screen right), y = +R (up), z = -T (forward is -z). Right-handed. */
export function rtnToWorld(v: Vec3, out?: Vec3): Vec3 {
  const o = out ?? [0, 0, 0];
  o[0] = -v[2] + 0; // + 0 avoids negative zero
  o[1] = v[0] + 0;
  o[2] = -v[1] + 0;
  return o;
}
