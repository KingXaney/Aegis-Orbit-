import type { CommittedManeuver, Conjunction, ScreenResponse } from '../types/api';
import type { GhostCrash } from './ghosts';

/** The soonest thing ahead on the clock: a committed burn, a screened closest approach or a ghost's collision. */
export interface NextEvent {
  kind: 'burn' | 'tca' | 'ghost';
  atUnix: number;
  id: string;
  label: string;
  /** A closest approach that still needs mitigation (CRITICAL/ELEVATED) or any burn. */
  critical: boolean;
}

export function nextEvent(
  screening: ScreenResponse | null | undefined,
  committed: CommittedManeuver[] | null | undefined,
  nowUnix: number,
  ghosts: GhostCrash[] = [],
): NextEvent | null {
  const events: NextEvent[] = [];
  for (const g of ghosts) {
    if (g.atUnix > nowUnix) events.push({ kind: 'ghost', atUnix: g.atUnix, id: g.id, label: g.label, critical: true });
  }
  for (const m of committed ?? []) {
    if (m.burn_time_unix > nowUnix) {
      events.push({ kind: 'burn', atUnix: m.burn_time_unix, id: m.maneuver_id, label: `burn ${m.direction} ${m.dv_magnitude_mps.toFixed(2)} m/s`, critical: true });
    }
  }
  for (const c of screening?.conjunctions ?? []) {
    if (c.tca_unix > nowUnix) {
      const km = c.miss_distance_km < 1 ? `${(c.miss_distance_km * 1000).toFixed(0)} m` : `${c.miss_distance_km.toFixed(1)} km`;
      events.push({
        kind: 'tca',
        atUnix: c.tca_unix,
        id: c.conjunction_id,
        label: `${c.secondary_name ?? c.secondary_id} passes at ${km}`,
        critical: c.threat_state === 'CRITICAL' || c.threat_state === 'ELEVATED',
      });
    }
  }
  if (events.length === 0) return null;
  events.sort((a, b) => a.atUnix - b.atUnix);
  return events[0];
}

/** The screened closest approach nearest to `now` within ± halfWindowS, or null. */
export function passWithin(screening: ScreenResponse | null | undefined, nowUnix: number, halfWindowS: number): Conjunction | null {
  let best: Conjunction | null = null;
  for (const c of screening?.conjunctions ?? []) {
    const dt = Math.abs(c.tca_unix - nowUnix);
    if (dt <= halfWindowS && (!best || dt < Math.abs(best.tca_unix - nowUnix))) best = c;
  }
  return best;
}

/** Something worth slowing down for: a committed burn, a close pass or a ghost's collision. */
export interface NearbyEvent {
  kind: 'burn' | 'tca' | 'ghost';
  atUnix: number;
  id: string;
  missKm: number | null;
}

/**
 * The committed burn, close pass (miss within `maxMissKm`) or ghost collision nearest to `now` inside
 * ± halfWindowS, or null when nothing is that close in time. Ghost collisions come from
 * `ghostCrashEvents`, which already stops listing a ghost once it is gone.
 */
export function eventWithin(
  screening: ScreenResponse | null | undefined,
  committed: CommittedManeuver[] | null | undefined,
  nowUnix: number,
  halfWindowS: number,
  maxMissKm = Number.POSITIVE_INFINITY,
  ghosts: GhostCrash[] = [],
): NearbyEvent | null {
  let best: NearbyEvent | null = null;
  // a ghost's collision outranks a pass or a burn at the same moment (the spacecraft's own pass with
  // the same debris, after the dodge, happens within seconds of it)
  const rank = (e: NearbyEvent) => (e.kind === 'ghost' ? 1 : 0);
  const consider = (e: NearbyEvent) => {
    const dt = Math.abs(e.atUnix - nowUnix);
    if (dt > halfWindowS) return;
    if (!best || rank(e) > rank(best) || (rank(e) === rank(best) && dt < Math.abs(best.atUnix - nowUnix))) best = e;
  };
  for (const m of committed ?? []) consider({ kind: 'burn', atUnix: m.burn_time_unix, id: m.maneuver_id, missKm: null });
  for (const g of ghosts) consider({ kind: 'ghost', atUnix: g.atUnix, id: g.id, missKm: g.missKm });
  for (const c of screening?.conjunctions ?? []) {
    if (c.miss_distance_km <= maxMissKm) consider({ kind: 'tca', atUnix: c.tca_unix, id: c.conjunction_id, missKm: c.miss_distance_km });
  }
  return best;
}
