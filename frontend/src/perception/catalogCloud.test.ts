import { describe, expect, it } from 'vitest';
import { STRIDE } from '../explorer/propagation';
import { temeAt } from './catalogCloud';

describe('temeAt', () => {
  const state = new Float32Array(2 * STRIDE);
  state.set([7000, 0, 0, 0, 7.5, 0], 0);
  state.fill(Number.NaN, STRIDE);

  it('extrapolates the TEME state linearly and converts km to metres', () => {
    const out = { x: 0, y: 0, z: 0 };
    expect(temeAt(state, 0, 10, out)).toEqual({ x: 7_000_000, y: 75_000, z: 0 });
    expect(temeAt(state, 0, -2, out)).toEqual({ x: 7_000_000, y: -15_000, z: 0 });
  });

  it('reports objects SGP4 could not propagate', () => {
    expect(temeAt(state, 1, 0, { x: 0, y: 0, z: 0 })).toBeNull();
  });
});
