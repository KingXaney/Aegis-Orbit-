import type { SpacecraftDesign } from '../types/api';
import type { Vec3 } from '../simulation/trajectory';

/**
 * Reaction-control thrusters on the spacecraft model and the plume they show when a burn fires.
 * Body frame as the globe draws it: x along the velocity (+T), y along the orbit normal (+N),
 * z radial (+R). Pure geometry and timing; the Cesium model draws it.
 */
export type NozzleFace = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
export const NOZZLE_FACES: NozzleFace[] = ['+x', '-x', '+y', '-y', '+z', '-z'];

export interface Nozzle {
  face: NozzleFace;
  /** Centre of the nozzle (body metres). */
  center: Vec3;
  /** Outward unit direction (the exhaust direction when this nozzle fires). */
  dir: Vec3;
  length: number;
  exitRadius: number;
}

export interface PlumeSpec {
  /** Centre of the plume cone (body metres), outward from the nozzle exit. */
  center: Vec3;
  dir: Vec3;
  length: number;
  baseRadius: number;
}

function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0];
}

/** A delta-v given in RTN (radial, along-track, cross-track) as a unit vector in the body frame (T, N, R). */
export function dvBodyDirection(dvRtn: number[]): Vec3 {
  return normalize([dvRtn[1] ?? 0, dvRtn[2] ?? 0, dvRtn[0] ?? 0]);
}

/** The nozzle that fires for a delta-v: its exhaust points opposite to the velocity change. */
export function firingFace(dvRtn: number[]): NozzleFace {
  const d = dvBodyDirection(dvRtn);
  const exhaust: Vec3 = [-d[0], -d[1], -d[2]];
  const axes: [number, 'x' | 'y' | 'z'][] = [[exhaust[0], 'x'], [exhaust[1], 'y'], [exhaust[2], 'z']];
  axes.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]));
  const [value, axis] = axes[0];
  return `${value >= 0 ? '+' : '-'}${axis}` as NozzleFace;
}

/**
 * Half extents of the spacecraft's core (the bus, not the solar arrays): nozzles sit on these faces.
 * The cross-track extent is capped at the larger of the other two, so a wide array span does not put
 * nozzles out on the array tips.
 */
export function coreHalfExtents(design: SpacecraftDesign): Vec3 {
  const { length_m: L, width_m: W, height_m: H } = design;
  return [L / 2, Math.min(W, Math.max(L, H)) / 2, H / 2];
}

const FACE_NORMALS: Record<NozzleFace, Vec3> = {
  '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1],
};

/** Six small nozzles, one on the centre of each core face, pointing outward. */
export function rcsNozzles(design: SpacecraftDesign): Nozzle[] {
  const half = coreHalfExtents(design);
  const length = Math.max(0.05, 0.08 * Math.min(design.length_m, design.height_m));
  const exitRadius = 0.5 * length;
  return NOZZLE_FACES.map((face) => {
    const n = FACE_NORMALS[face];
    const offset = half[Math.abs(n[0]) ? 0 : Math.abs(n[1]) ? 1 : 2] + length / 2;
    return { face, center: [n[0] * offset, n[1] * offset, n[2] * offset], dir: n, length, exitRadius };
  });
}

/** The plume cone for a face: from the nozzle exit outward, long enough to read from a chase camera. */
export function plumeSpec(design: SpacecraftDesign, face: NozzleFace): PlumeSpec {
  const nozzle = rcsNozzles(design).find((n) => n.face === face)!;
  const largest = Math.max(design.length_m, design.width_m, design.height_m);
  const length = 2.5 * largest;
  const exit: Vec3 = [
    nozzle.center[0] + nozzle.dir[0] * nozzle.length / 2,
    nozzle.center[1] + nozzle.dir[1] * nozzle.length / 2,
    nozzle.center[2] + nozzle.dir[2] * nozzle.length / 2,
  ];
  return {
    center: [exit[0] + nozzle.dir[0] * length / 2, exit[1] + nozzle.dir[1] * length / 2, exit[2] + nozzle.dir[2] * length / 2],
    dir: nozzle.dir,
    length,
    baseRadius: 0.12 * largest,
  };
}

/** What a nozzle does, for captions: which nozzle fires and which way that pushes the spacecraft. */
export function describeFace(face: NozzleFace): { nozzle: string; effect: string } {
  switch (face) {
    case '-x': return { nozzle: 'aft nozzle', effect: 'speeds the orbit up (+T): the spacecraft climbs and arrives later' };
    case '+x': return { nozzle: 'forward nozzle', effect: 'slows the orbit down (−T): the spacecraft drops and arrives earlier' };
    case '-z': return { nozzle: 'nadir nozzle', effect: 'pushes outward (+R)' };
    case '+z': return { nozzle: 'zenith nozzle', effect: 'pushes inward (−R)' };
    case '-y': return { nozzle: 'cross-track nozzle', effect: 'pushes along the orbit normal (+N)' };
    default: return { nozzle: 'cross-track nozzle', effect: 'pushes against the orbit normal (−N)' };
  }
}

// ---------------------------------------------------------------- timing

/** How long a burn shows on screen (real time, whatever the clock speed): the burn itself is impulsive. */
export const FIRE_MS = 2500;
/** Real seconds before a burn during which the nozzle glows faintly, so the eye is on it when it fires. */
export const PRE_GLOW_REAL_S = 0.75;
/** A burn that turns up already in the past (evaluation latency) still fires if it is this recent, in clock-speed units. */
export const LATE_FIRE_FACTOR = 5;
export const PRE_GLOW_INTENSITY = 0.25;

export interface BurnRef {
  id: string;
  burnUnix: number;
  dvRtn: number[];
}

export interface PlumeInput {
  nowUnix: number;
  speed: number;
  playing: boolean;
  realNowMs: number;
  burns: BurnRef[];
}

export interface PlumeState {
  lastNow: number | null;
  firedIds: string[];
  active: { id: string; face: NozzleFace; startedMs: number } | null;
  preGlow: { id: string; face: NozzleFace } | null;
}

export const INITIAL_PLUME: PlumeState = { lastNow: null, firedIds: [], active: null, preGlow: null };

/**
 * One frame of the plume state machine. A burn fires once, when the clock crosses its time going
 * forward (a jump backwards, such as a reset, never fires anything); a burn that first appears
 * already slightly in the past fires late. Of several burns crossed in one frame the latest fires.
 */
export function advancePlume(state: PlumeState, input: PlumeInput): PlumeState {
  const { nowUnix, speed, playing, realNowMs, burns } = input;
  // a burn stays "fired" only while it is in the list and the clock is past it: scrubbing back before
  // a burn (the scripted scenarios' timeline) lets it fire again when the clock crosses it once more
  const byId = new Map(burns.map((b) => [b.id, b]));
  let firedIds = state.firedIds.filter((id) => (byId.get(id)?.burnUnix ?? Number.POSITIVE_INFINITY) <= nowUnix);
  let active = state.active && realNowMs - state.active.startedMs < FIRE_MS && byId.has(state.active.id) ? state.active : null;
  const jumpedBack = state.lastNow !== null && nowUnix < state.lastNow;
  let fire: BurnRef | null = null;
  const nowFired: string[] = [];
  for (const b of burns) {
    if (firedIds.includes(b.id) || b.burnUnix > nowUnix) continue;
    nowFired.push(b.id);
    if (state.lastNow === null || jumpedBack) continue; // first frame or a reset: already-past burns never fire
    const crossed = state.lastNow < b.burnUnix;
    const late = !crossed && nowUnix - b.burnUnix < LATE_FIRE_FACTOR * Math.max(speed, 1);
    if ((crossed || late) && (fire === null || b.burnUnix > fire.burnUnix)) fire = b;
  }
  if (nowFired.length) firedIds = [...firedIds, ...nowFired];
  if (fire) active = { id: fire.id, face: firingFace(fire.dvRtn), startedMs: realNowMs };
  let preGlow: PlumeState['preGlow'] = null;
  if (playing && !active) {
    const next = burns.filter((b) => b.burnUnix > nowUnix).sort((a, b) => a.burnUnix - b.burnUnix)[0];
    if (next && (next.burnUnix - nowUnix) / Math.max(speed, 1e-9) < PRE_GLOW_REAL_S) preGlow = { id: next.id, face: firingFace(next.dvRtn) };
  }
  return { lastNow: nowUnix, firedIds, active, preGlow };
}

/** Plume brightness in [0, 1]: full at ignition, fading over FIRE_MS; a faint glow just before a burn. */
export function plumeIntensity(state: PlumeState, realNowMs: number): number {
  if (state.active) {
    const x = Math.min(1, Math.max(0, (realNowMs - state.active.startedMs) / FIRE_MS));
    return (1 - x) * (1 - x * 0.5);
  }
  return state.preGlow ? PRE_GLOW_INTENSITY : 0;
}
