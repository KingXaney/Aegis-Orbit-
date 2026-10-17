import { describe, expect, it } from 'vitest';
import { cross, dot, norm, relativeStateRtn, rtnBasis, rtnToWorld } from './rtn';
import type { Vec3 } from '../simulation/trajectory';

const MU = 398600.4418;

function circular(a: number, incDeg: number, raanDeg: number, uDeg: number): { p: Vec3; v: Vec3 } {
  const inc = (incDeg * Math.PI) / 180;
  const raan = (raanDeg * Math.PI) / 180;
  const u = (uDeg * Math.PI) / 180;
  const rpf: Vec3 = [a * Math.cos(u), a * Math.sin(u), 0];
  const vmag = Math.sqrt(MU / a);
  const vpf: Vec3 = [-vmag * Math.sin(u), vmag * Math.cos(u), 0];
  const rot = (x: Vec3): Vec3 => [
    Math.cos(raan) * x[0] - Math.sin(raan) * Math.cos(inc) * x[1] + Math.sin(raan) * Math.sin(inc) * x[2],
    Math.sin(raan) * x[0] + Math.cos(raan) * Math.cos(inc) * x[1] - Math.cos(raan) * Math.sin(inc) * x[2],
    Math.sin(inc) * x[1] + Math.cos(inc) * x[2],
  ];
  return { p: rot(rpf), v: rot(vpf) };
}

describe('rtn', () => {
  it('builds an orthonormal right-handed basis with T along the velocity', () => {
    const s = circular(7000, 30, 40, 50);
    const b = rtnBasis(s.p, s.v);
    expect(Math.abs(dot(b.r, b.t))).toBeLessThan(1e-12);
    expect(Math.abs(dot(b.r, b.n))).toBeLessThan(1e-12);
    expect(norm(b.t)).toBeCloseTo(1, 12);
    const c = cross(b.r, b.t);
    expect(c[0]).toBeCloseTo(b.n[0], 12);
    expect(dot(b.t, s.v)).toBeGreaterThan(0);
  });

  it('removes the transport term: a companion on the same orbit has no co-moving velocity', () => {
    const a = 6798.137;
    const p = circular(a, 51.6, 20, 10);
    const s = circular(a, 51.6, 20, 11);
    const rel = relativeStateRtn(p, s);
    const d = Math.PI / 180;
    expect(rel.r[0]).toBeCloseTo(a * (Math.cos(d) - 1), 8);
    expect(rel.r[1]).toBeCloseTo(a * Math.sin(d), 8);
    expect(norm(rel.v)).toBeLessThan(1e-9);
  });

  it('gives the crossing speed for an inclined companion at the node', () => {
    const a = 7000;
    const p = circular(a, 0, 0, 0);
    const s = circular(a, 60, 0, 0);
    const rel = relativeStateRtn(p, s);
    const v = Math.sqrt(MU / a);
    expect(norm(rel.r)).toBeLessThan(1e-9);
    expect(norm(rel.v)).toBeCloseTo(2 * v * Math.sin(Math.PI / 6), 6);
  });

  it('maps RTN to a right-handed world frame', () => {
    expect(rtnToWorld([1, 0, 0])).toEqual([0, 1, 0]);
    expect(rtnToWorld([0, 1, 0])).toEqual([0, 0, -1]);
    expect(rtnToWorld([0, 0, 1])).toEqual([-1, 0, 0]);
    const x = rtnToWorld([0, 0, 1]);
    const y = rtnToWorld([1, 0, 0]);
    const z = rtnToWorld([0, 1, 0]);
    expect(cross(x, y)).toEqual(z);
  });
});
