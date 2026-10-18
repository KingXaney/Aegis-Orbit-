// Ghost satellites: for every committed burn, a translucent copy of the spacecraft keeps flying the
// course it was on before that burn, until the pass the burn avoided. Everything here is pure and
// derived from the clock, so bounded clocks can scrub backwards through a ghost's life.
import type { CommittedManeuver, ObjectSummary, Trajectory } from '../types/api';
import { SampledTrajectory, type Vec3 } from './trajectory';

/** The warning (and the slow motion) start this many simulated seconds before a ghost's collision. */
export const GHOST_WARN_S = 60;
/** The impact flash lasts this long after the collision; shorter than the 10 s slow-motion core, so the clock stays at 1× through it. */
export const GHOST_HOLD_S = 8;
/** A ghost's path is fetched this far beyond both ends of its life. */
export const GHOST_FETCH_MARGIN_S = 120;
export const GHOST_MAX_ATTEMPTS = 3;

export type GhostStatus = 'loading' | 'ready' | 'failed';
export type GhostPhase = 'pending' | 'alive' | 'crashing' | 'gone';

export interface Ghost {
  /** The committed burn's maneuver id. */
  id: string;
  /** 1-based, in burn order: "Ghost 1". */
  index: number;
  /** The burn time: the ghost separates from the real spacecraft here. */
  bornUnix: number;
  /** The avoided pass's pre-burn closest approach: where the ghost meets the debris. */
  crashUnix: number;
  /** The pre-burn miss distance (a near miss, kept honest in every text). */
  missKm: number;
  /** The real spacecraft's miss at the same pass after the burn. */
  postMissKm: number;
  secondaryId: string;
  secondaryName: string;
  relativeSpeedKms: number | null;
  criticalRadiusKm: number;
  /** The ghost's TEME position (km) at the collision, from the screening when available. */
  crashPointTeme: Vec3 | null;
  /** The course before the burn, fetched once (`variant=before_burn`); null while loading. */
  trajectory: Trajectory | null;
  status: GhostStatus;
  attempts: number;
}

export interface GhostCrash {
  id: string;
  atUnix: number;
  missKm: number;
  label: string;
}

export interface GhostWarning {
  ghost: Ghost;
  /** Seconds until the collision (negative during the hold after it). */
  dt: number;
  phase: 'warning' | 'crashed';
}

const vec3 = (xs: number[] | null | undefined): Vec3 | null => (xs && xs.length === 3 && xs.every(Number.isFinite) ? [xs[0], xs[1], xs[2]] : null);

export function ghostPhase(g: Ghost, nowUnix: number, holdS = GHOST_HOLD_S): GhostPhase {
  if (nowUnix < g.bornUnix) return 'pending';
  if (nowUnix < g.crashUnix) return 'alive';
  if (nowUnix < g.crashUnix + holdS) return 'crashing';
  return 'gone';
}

/**
 * One ghost per committed burn that recorded the pass it avoided (and whose object still exists, when
 * `objects` is given), in burn order. Entries of `existing` are kept by id, so a fetched path survives
 * the simulation state being replaced; when nothing changed the very same array comes back.
 */
export function ghostsFromCommitted(
  committed: CommittedManeuver[] | null | undefined,
  existing: Ghost[],
  criticalRadiusKm: number,
  objects?: Record<string, ObjectSummary>,
): Ghost[] {
  const byId = new Map(existing.map((g) => [g.id, g]));
  const next: Ghost[] = [];
  for (const m of committed ?? []) {
    const ap = m.avoided_pass;
    if (!ap || !ap.secondary_id || !Number.isFinite(ap.tca_unix)) continue;
    if (objects && !objects[ap.secondary_id]) continue;
    const index = next.length + 1;
    const old = byId.get(m.maneuver_id);
    if (old) {
      next.push(old.index === index ? old : { ...old, index });
      continue;
    }
    next.push({
      id: m.maneuver_id,
      index,
      bornUnix: m.burn_time_unix,
      crashUnix: ap.tca_unix,
      missKm: ap.miss_km,
      postMissKm: m.post_miss_distance_km,
      secondaryId: ap.secondary_id,
      secondaryName: ap.secondary_name ?? ap.secondary_id,
      relativeSpeedKms: ap.relative_speed_kms,
      criticalRadiusKm,
      crashPointTeme: vec3(ap.ghost_r_km),
      trajectory: null,
      status: 'loading',
      attempts: 0,
    });
  }
  const same = next.length === existing.length && next.every((g, i) => g === existing[i]);
  return same ? existing : next;
}

export function ghostFetchRange(g: Ghost, marginS = GHOST_FETCH_MARGIN_S): { startUnix: number; endUnix: number } {
  return { startUnix: g.bornUnix - marginS, endUnix: g.crashUnix + marginS };
}

/** Ghosts that are flying or crashing at `now`, soonest collision first. */
export function aliveGhosts(ghosts: Ghost[], nowUnix: number, holdS = GHOST_HOLD_S): Ghost[] {
  return ghosts
    .filter((g) => {
      const p = ghostPhase(g, nowUnix, holdS);
      return p === 'alive' || p === 'crashing';
    })
    .sort((a, b) => a.crashUnix - b.crashUnix);
}

/** The collisions worth slowing down for: every ghost that is born and not yet gone. */
export function ghostCrashEvents(ghosts: Ghost[], nowUnix: number, holdS = GHOST_HOLD_S): GhostCrash[] {
  return aliveGhosts(ghosts, nowUnix, holdS).map((g) => ({
    // not the burn's own id: the slow motion keys its record by event id, and the burn is an event too
    id: `ghost:${g.id}`,
    atUnix: g.crashUnix,
    missKm: g.missKm,
    label: `ghost meets ${g.secondaryName} (${formatMiss(g.missKm)})`,
  }));
}

/** Ghosts to delete: only an open-ended clock forgets them (a bounded one can scrub back). */
export function expiredGhostIds(ghosts: Ghost[], nowUnix: number, openEnded: boolean, holdS = GHOST_HOLD_S): string[] {
  if (!openEnded) return [];
  return ghosts.filter((g) => ghostPhase(g, nowUnix, holdS) === 'gone').map((g) => g.id);
}

/** The ghost to warn about: the soonest collision inside `warnS`, or the one in its hold after crashing. */
export function ghostWarning(ghosts: Ghost[], nowUnix: number, warnS = GHOST_WARN_S, holdS = GHOST_HOLD_S): GhostWarning | null {
  let best: GhostWarning | null = null;
  for (const g of ghosts) {
    const phase = ghostPhase(g, nowUnix, holdS);
    const dt = g.crashUnix - nowUnix;
    if (phase === 'crashing' || (phase === 'alive' && dt <= warnS)) {
      if (!best || dt < best.dt) best = { ghost: g, dt, phase: phase === 'crashing' ? 'crashed' : 'warning' };
    }
  }
  return best;
}

export function formatMiss(km: number): string {
  if (!Number.isFinite(km)) return '—';
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

export function ghostWarningText(g: Ghost, dt: number): string {
  if (dt >= 0) {
    return `Without the dodge: ghost meets ${g.secondaryName} in ${formatClock(dt)} (${formatMiss(g.missKm)}, inside the ${g.criticalRadiusKm} km safety radius)`;
  }
  return `The ghost would have passed ${formatMiss(g.missKm)} from ${g.secondaryName}; the spacecraft is safe on its new path at ${formatMiss(g.postMissKm)}`;
}

/** "Ghost 1 · no burn 02:46:40" (the burn it did not make, UTC). */
export function ghostLabel(g: Ghost): string {
  return `Ghost ${g.index} · no burn ${new Date(g.bornUnix * 1000).toISOString().slice(11, 19)}`;
}

/** Where the ghost meets the debris: the screened point when known, else a sample of its own path. */
export function crashPointOf(g: Ghost): Vec3 | null {
  if (g.crashPointTeme) return g.crashPointTeme;
  if (!g.trajectory) return null;
  return new SampledTrajectory(g.trajectory).positionAt(g.crashUnix) ?? null;
}
