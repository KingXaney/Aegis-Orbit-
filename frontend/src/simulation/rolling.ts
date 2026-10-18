import type { Trajectory } from '../types/api';

/**
 * Rolling orbit data for the open-ended sandbox clock: trajectories are fetched in chunks ahead of
 * the clock and trimmed behind it, so the spacecraft can orbit for as long as the page is open.
 * Pure helpers; the store applies them.
 */
export const CHUNK_ORBITS = 2;
export const KEEP_BEHIND_ORBITS = 1;
/** Real seconds of lead the loaded data must keep ahead of the clock (covers a fetch at any speed). */
export const LEAD_REAL_S = 20;
/** The backend refuses more samples than this per trajectory. */
export const MAX_SAMPLES = 20000;

/** True when the loaded data ends less than an orbit (or LEAD_REAL_S of clock) ahead of now. */
export function extensionNeeded(nowUnix: number, speed: number, loadedEndUnix: number, periodS: number): boolean {
  return loadedEndUnix - nowUnix < Math.max(periodS, speed * LEAD_REAL_S);
}

/** The next chunk to fetch: at least two orbits, more at high speed, never more than MAX_SAMPLES. */
export function nextChunk(loadedEndUnix: number, periodS: number, speed: number, stepS: number): { start: number; end: number } {
  const span = Math.min(Math.max(CHUNK_ORBITS * periodS, 2 * speed * LEAD_REAL_S), MAX_SAMPLES * stepS);
  return { start: loadedEndUnix, end: loadedEndUnix + span };
}

/** The clock has reached the end of the loaded data. */
export function stalled(nowUnix: number, loadedEndUnix: number): boolean {
  return nowUnix > loadedEndUnix - 1;
}

/** Append a later chunk (its samples at or before the existing end are dropped: the grids share an end point). */
export function mergeTrajectory(existing: Trajectory, chunk: Trajectory): Trajectory {
  const lastT = existing.times_unix.length ? existing.times_unix[existing.times_unix.length - 1] : Number.NEGATIVE_INFINITY;
  const keep: number[] = [];
  for (let i = 0; i < chunk.times_unix.length; i++) if (chunk.times_unix[i] > lastT + 1e-6) keep.push(i);
  if (keep.length === 0) return existing;
  const burns = new Set([...(existing.burn_times_unix ?? []), ...(chunk.burn_times_unix ?? [])]);
  const messages = [...existing.messages];
  for (const m of chunk.messages) if (!messages.includes(m)) messages.push(m);
  return {
    ...existing,
    end: chunk.end,
    times_unix: [...existing.times_unix, ...keep.map((i) => chunk.times_unix[i])],
    positions_km: [...existing.positions_km, ...keep.map((i) => chunk.positions_km[i])],
    velocities_kms: [...existing.velocities_kms, ...keep.map((i) => chunk.velocities_kms[i])],
    segments: [...existing.segments, ...chunk.segments],
    status: existing.status === 'OK' && chunk.status === 'OK' ? 'OK' : existing.status === 'FAILED' && chunk.status === 'FAILED' ? 'FAILED' : 'PARTIAL',
    messages,
    burn_times_unix: [...burns].sort((a, b) => a - b),
    variant: chunk.variant ?? existing.variant,
  };
}

/** Drop samples before `keepFromUnix`, keeping the one just before it so interpolation stays valid there. */
export function trimTrajectory(t: Trajectory, keepFromUnix: number): Trajectory {
  const n = t.times_unix.length;
  let i = 0;
  while (i + 1 < n && t.times_unix[i + 1] <= keepFromUnix) i++;
  if (i === 0) return t;
  return {
    ...t,
    start: new Date(t.times_unix[i] * 1000).toISOString(),
    times_unix: t.times_unix.slice(i),
    positions_km: t.positions_km.slice(i),
    velocities_kms: t.velocities_kms.slice(i),
  };
}
