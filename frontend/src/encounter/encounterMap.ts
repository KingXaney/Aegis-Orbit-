import type { Vec3 } from '../simulation/trajectory';
import { cross, dot, normalize } from './rtn';
import type { EncounterItem } from './encounters';

/**
 * Encounter-map projection constants. 1 scene unit = 1 km laterally inside the
 * linear zone; the along-road axis is time to each object's closest approach.
 */
export const MAP = {
  LINEAR_LATERAL_KM: 3,
  LINEAR_UNITS: 3,
  EDGE_UNITS: 6,
  SHOULDER_UNITS: 0.5,
  LINEAR_S: 600,
  LINEAR_ALONG_UNITS: 30,
  BEHIND_MAX_UNITS: 15,
  FADE_START_S: 60,
  FADE_END_S: 180,
  TRAIL_UNITS_PER_KM: 8 / 690,
  RIBBON_WIDTH_UNITS: 1,
  SAT_SPAN_UNITS: 1.35,
  ROAD_LENGTH_UNITS: 140,
};

export interface EncounterThresholds {
  criticalKm: number;
  trackedKm: number;
  horizonS: number;
  nearFieldS: number;
}

export const DEFAULT_THRESHOLDS: EncounterThresholds = { criticalKm: 5, trackedKm: 25, horizonS: 2 * 5578, nearFieldS: 1800 };

/**
 * Encounter-plane basis of one object: the plane perpendicular to the relative
 * velocity w. L is the horizontal in-plane axis (R x w), U the in-plane "up"
 * axis (w x L), which equals the radial direction for horizontal crossings.
 */
export function encounterPlaneBasis(vRelRtn: Vec3): { L: Vec3; U: Vec3; w: Vec3 } {
  const R: Vec3 = [1, 0, 0];
  const w = normalize(vRelRtn);
  let L = cross(R, w);
  const n = Math.hypot(L[0], L[1], L[2]);
  if (n < 1e-9) L = [0, 0, 1];
  else L = [L[0] / n, L[1] / n, L[2] / n];
  const U = n < 1e-9 ? ([0, 1, 0] as Vec3) : normalize(cross(w, L));
  return { L, U, w };
}

/** Signed lateral (x, km), radial (y, km) and along-velocity (km) components of a miss vector. */
export function encounterPlaneOffset(missRtn: Vec3, vRelRtn: Vec3): { x: number; y: number; along: number; L: Vec3; U: Vec3 } {
  const { L, U, w } = encounterPlaneBasis(vRelRtn);
  return { x: dot(missRtn, L), y: dot(missRtn, U), along: dot(missRtn, w), L, U };
}

/** Lateral km -> scene units: linear to 3 km, logarithmic to the road edge (tracked radius), then a shoulder. */
export function lateralUnits(km: number, edgeKm: number = DEFAULT_THRESHOLDS.trackedKm): number {
  const a = Math.abs(km);
  const s = Math.sign(km) || 1;
  if (a <= MAP.LINEAR_LATERAL_KM) return km;
  if (a <= edgeKm) {
    return s * (MAP.LINEAR_UNITS + (MAP.EDGE_UNITS - MAP.LINEAR_UNITS) * Math.log(a / MAP.LINEAR_LATERAL_KM) / Math.log(edgeKm / MAP.LINEAR_LATERAL_KM));
  }
  return s * (MAP.EDGE_UNITS + MAP.SHOULDER_UNITS * Math.min(1, (a - edgeKm) / edgeKm));
}

/** Time-to-encounter (s) -> units ahead: linear for the first 10 minutes, logarithmic beyond (C1 at the joint). */
export function alongUnits(tauS: number): number {
  if (tauS <= MAP.LINEAR_S) return Math.max(-MAP.BEHIND_MAX_UNITS, (MAP.LINEAR_ALONG_UNITS * tauS) / MAP.LINEAR_S);
  return MAP.LINEAR_ALONG_UNITS * (1 + Math.log(tauS / MAP.LINEAR_S));
}

export function inverseAlong(u: number): number {
  if (u <= MAP.LINEAR_ALONG_UNITS) return (u * MAP.LINEAR_S) / MAP.LINEAR_ALONG_UNITS;
  return MAP.LINEAR_S * Math.exp(u / MAP.LINEAR_ALONG_UNITS - 1);
}

export interface LaneTick {
  km: number;
  u: number;
  kind: 'linear' | 'critical' | 'dashed' | 'edge';
  label: string;
}

export function laneTicks(thr: EncounterThresholds): LaneTick[] {
  const out: LaneTick[] = [];
  const push = (km: number, kind: LaneTick['kind'], label: string) => {
    out.push({ km, u: lateralUnits(km, thr.trackedKm), kind, label });
    out.push({ km: -km, u: lateralUnits(-km, thr.trackedKm), kind, label });
  };
  for (const km of [1, 2, 3]) if (km < thr.criticalKm) push(km, 'linear', `${km} km`);
  push(thr.criticalKm, 'critical', `${thr.criticalKm} km critical`);
  if (thr.criticalKm < 10 && 10 < thr.trackedKm) push(10, 'dashed', '10 km');
  push(thr.trackedKm, 'edge', `${thr.trackedKm} km screening radius`);
  return out;
}

export interface TimeTick {
  tauS: number;
  u: number;
  label: string;
}

export function timeTicks(horizonS: number): TimeTick[] {
  const candidates: [number, string][] = [
    [60, 'T−1 min'], [120, 'T−2 min'], [300, 'T−5 min'], [600, 'T−10 min'], [1200, 'T−20 min'], [1800, 'T−30 min'],
    [3600, 'T−1 h'], [7200, 'T−2 h'], [10800, 'T−3 h'], [6 * 3600, 'T−6 h'], [12 * 3600, 'T−12 h'], [24 * 3600, 'T−24 h'],
  ];
  return candidates.filter(([s]) => s <= horizonS).map(([s, label]) => ({ tauS: s, u: alongUnits(s), label }));
}

export interface MapPosition {
  x: number;
  y: number;
  z: number;
  opacity: number;
  visible: boolean;
  tauS: number;
}

/** Where an encounter sits on the map at simulation time `now`. */
export function objectMapPosition(item: EncounterItem, nowUnix: number, thr: EncounterThresholds): MapPosition {
  if (item.tcaUnix === null || !item.offset) return { x: 0, y: 0, z: 0, opacity: 0, visible: false, tauS: NaN };
  const tau = item.tcaUnix - nowUnix;
  const tierHorizon = item.tier === 'CRITICAL' ? thr.horizonS : thr.nearFieldS;
  let opacity = 1;
  if (tau < -MAP.FADE_START_S) opacity = Math.max(0, 1 - (-tau - MAP.FADE_START_S) / (MAP.FADE_END_S - MAP.FADE_START_S));
  const visible = tau <= tierHorizon && opacity > 0;
  const x = lateralUnits(item.offset.x, thr.trackedKm);
  const y = Math.max(-3, Math.min(3, item.offset.y));
  return { x, y, z: -alongUnits(tau), opacity, visible, tauS: tau };
}

/**
 * Trail offsets (scene units, relative to the box) from the perception trail:
 * the object's motion relative to the satellite in RTN, scaled, so a crossing
 * debris streaks across the road at its true crossing angle.
 */
export function trailMapOffsets(item: EncounterItem): Float32Array {
  if (!item.trail || !item.missRtn || !item.offset) return new Float32Array(0);
  const c = MAP.TRAIL_UNITS_PER_KM;
  const sgn = dot(item.offset.L, [0, 0, 1]) < 0 ? 1 : -1; // world x = -N; flip when the lateral axis points along -N
  const out = new Float32Array(item.trail.rtnKm.length * 3);
  for (let i = 0; i < item.trail.rtnKm.length; i++) {
    const p = item.trail.rtnKm[i];
    const dR = p[0] - item.missRtn[0];
    const dT = p[1] - item.missRtn[1];
    const dN = p[2] - item.missRtn[2];
    out[i * 3] = sgn * c * dN;
    out[i * 3 + 1] = c * dR;
    out[i * 3 + 2] = -c * dT;
  }
  return out;
}
