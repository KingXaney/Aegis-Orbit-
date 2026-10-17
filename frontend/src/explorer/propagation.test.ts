import { describe, expect, it } from 'vitest';
import { STRIDE, altitudeKm, gmst, orbitPoints, parseSatrecs, propagateAll, speedKms, temeToFixed } from './propagation';

// Same element set as backend/tests/conftest.py (epoch 2026-10-17).
const ISS: [string, string] = [
  '1 25544U 98067A   26290.17683437  .00008767  00000+0  16757-3 0  9994',
  '2 25544  51.6327  56.4129 0006776 273.6806  86.3408 15.48906925590665',
];
const EPOCH_UNIX = Date.UTC(2026, 9, 17, 4, 14, 38) / 1000;

describe('propagation', () => {
  it('puts the ISS at its altitude and orbital speed', () => {
    const satrecs = parseSatrecs([ISS]);
    const out = new Float32Array(STRIDE);
    expect(propagateAll(satrecs, EPOCH_UNIX + 3600, out)).toBe(0);
    expect(altitudeKm(out)).toBeGreaterThan(400);
    expect(altitudeKm(out)).toBeLessThan(430);
    expect(speedKms(out)).toBeCloseTo(7.66, 1);
  });

  it('writes NaN for records SGP4 rejects', () => {
    const bad = parseSatrecs([[ISS[0], ISS[1].replace('15.48906925', '00.00000001')]]);
    const out = new Float32Array(STRIDE);
    expect(propagateAll(bad, EPOCH_UNIX, out)).toBe(1);
    expect(Number.isNaN(out[0])).toBe(true);
  });

  it('returns a closed orbit over one period', () => {
    const [sat] = parseSatrecs([ISS]);
    const pts = orbitPoints(sat, 92.97, EPOCH_UNIX, 90);
    expect(pts.length).toBe(91 * 3);
    const gap = Math.hypot(pts[0] - pts[270], pts[1] - pts[271], pts[2] - pts[272]);
    expect(gap).toBeLessThan(60); // km: nodal drift and drag over one revolution
  });

  it('rotates about Z without changing the radius', () => {
    const theta = gmst(EPOCH_UNIX);
    expect(theta).toBeGreaterThanOrEqual(0);
    expect(theta).toBeLessThan(2 * Math.PI);
    const [x, y, z] = temeToFixed(4000, 3000, 5000, theta);
    expect(Math.hypot(x, y, z)).toBeCloseTo(Math.hypot(4000, 3000, 5000), 6);
    expect(z).toBe(5000);
  });
});
