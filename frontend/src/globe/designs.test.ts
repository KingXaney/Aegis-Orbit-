import { describe, expect, it } from 'vitest';
import { designParts, partBounds } from './designs';
import type { SpacecraftDesign } from '../types/api';

const design = (design_id: string, length_m: number, width_m: number, height_m: number): SpacecraftDesign => ({
  design_id, label: design_id, length_m, width_m, height_m, basis: 'TEST', reference: '',
});

const CASES = [
  design('iss', 73, 109, 20),
  design('box-wing-bus', 2.4, 14, 2.2),
  design('compact-bus', 2, 1.7, 1.6),
  design('debris-fragment', 3.6, 1.8, 0.5),
  design('rocket-body', 9, 2.9, 2.9),
];

describe('spacecraft designs', () => {
  it.each(CASES)('$design_id stays inside and fills its envelope', (d) => {
    const [min, max] = partBounds(designParts(d));
    const dims = [d.length_m, d.width_m, d.height_m];
    for (let i = 0; i < 3; i++) {
      expect(min[i]).toBeGreaterThanOrEqual(-dims[i] / 2 - 1e-9);
      expect(max[i]).toBeLessThanOrEqual(dims[i] / 2 + 1e-9);
      expect(max[i] - min[i]).toBeGreaterThan(0.95 * dims[i]);
    }
  });

  it('draws the ISS truss across track and its modules along track', () => {
    const parts = designParts(design('iss', 73, 109, 20));
    const truss = parts[0];
    expect(truss.kind === 'box' && truss.size[1]).toBeGreaterThan(100);
    expect(parts.filter((p) => p.color === 'issArray')).toHaveLength(8);
    expect(parts.some((p) => p.kind === 'cylinder' && p.axis === 'x')).toBe(true);
  });

  it.each(CASES)('$design_id has no coplanar overlapping faces (z-fighting)', (d) => {
    const boxes = designParts(d).filter((p) => p.kind === 'box');
    // faces closer than this, facing the same way and overlapping, flicker in the depth buffer
    const tol = 2e-4 * Math.max(d.length_m, d.width_m, d.height_m);
    const clashes: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (a.kind !== 'box' || b.kind !== 'box' || a.color === b.color) continue;
        for (let axis = 0; axis < 3; axis++) {
          const others = [0, 1, 2].filter((k) => k !== axis);
          const overlap = others.every((k) => Math.abs(a.center[k] - b.center[k]) < (a.size[k] + b.size[k]) / 2 - tol);
          if (!overlap) continue;
          for (const sign of [1, -1]) {
            const fa = a.center[axis] + (sign * a.size[axis]) / 2;
            const fb = b.center[axis] + (sign * b.size[axis]) / 2;
            if (Math.abs(fa - fb) < tol) clashes.push(`${a.color}#${i} / ${b.color}#${j} on ${'xyz'[axis]}${sign > 0 ? '+' : '-'}`);
          }
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it('falls back to a compact bus for unknown design ids', () => {
    expect(designParts(design('mystery', 1, 1, 1))).toEqual(designParts(design('compact-bus', 1, 1, 1)));
  });
});
