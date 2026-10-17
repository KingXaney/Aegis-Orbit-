import { gstime, sgp4, twoline2satrec, type SatRec } from 'satellite.js';

// SGP4 for the catalog explorer. Unlike the mission page, this page propagates in the browser:
// 25k+ objects cannot be precomputed per session. States are TEME, km and km/s, as from sgp4;
// the globe rotates the whole TEME set into the Earth-fixed frame with one GMST rotation per frame
// (polar motion and the TEME/PEF distinction are ignored: sub-kilometre, invisible at globe scale).

export const R_EARTH_KM = 6378.137;
export const STRIDE = 6; // floats per object in a state buffer: px py pz vx vy vz

export function julianDate(unix: number): number {
  return unix / 86400 + 2440587.5;
}

/** Greenwich mean sidereal time, radians. */
export function gmst(unix: number): number {
  return gstime(julianDate(unix));
}

export function parseSatrecs(tles: [string, string][]): SatRec[] {
  return tles.map(([l1, l2]) => twoline2satrec(l1, l2));
}

/** Propagate every satrec to `unix`, writing TEME states into `out`. Failed objects get NaN. Returns the failure count. */
export function propagateAll(satrecs: SatRec[], unix: number, out: Float32Array): number {
  const jd = julianDate(unix);
  let failed = 0;
  for (let i = 0; i < satrecs.length; i++) {
    const s = satrecs[i];
    const o = i * STRIDE;
    const pv = s.error === 0 ? sgp4(s, (jd - s.jdsatepoch) * 1440) : null;
    if (!pv || !pv.position || !pv.velocity) {
      out.fill(Number.NaN, o, o + STRIDE);
      failed++;
      continue;
    }
    out[o] = pv.position.x;
    out[o + 1] = pv.position.y;
    out[o + 2] = pv.position.z;
    out[o + 3] = pv.velocity.x;
    out[o + 4] = pv.velocity.y;
    out[o + 5] = pv.velocity.z;
  }
  return failed;
}

/** One orbital period of TEME positions (km), starting at `unix`, closed back onto the first point. */
export function orbitPoints(satrec: SatRec, periodMin: number, unix: number, samples = 180): Float32Array {
  const out = new Float32Array((samples + 1) * 3);
  const jd0 = julianDate(unix);
  let n = 0;
  for (let k = 0; k <= samples; k++) {
    const tsince = (jd0 - satrec.jdsatepoch) * 1440 + (periodMin * k) / samples;
    const pv = sgp4(satrec, tsince);
    if (!pv || !pv.position) continue;
    out[n++] = pv.position.x;
    out[n++] = pv.position.y;
    out[n++] = pv.position.z;
  }
  return out.subarray(0, n);
}

export function altitudeKm(state: ArrayLike<number>, offset = 0): number {
  return Math.hypot(state[offset], state[offset + 1], state[offset + 2]) - R_EARTH_KM;
}

/** Inertial speed, km/s (the figure catalogues quote: about 7.66 km/s for the ISS). */
export function speedKms(state: ArrayLike<number>, offset = 0): number {
  return Math.hypot(state[offset + 3], state[offset + 4], state[offset + 5]);
}

/** Rotate a TEME vector into the Earth-fixed frame about Z by GMST. */
export function temeToFixed(x: number, y: number, z: number, theta: number): [number, number, number] {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [c * x + s * y, -s * x + c * y, z];
}
