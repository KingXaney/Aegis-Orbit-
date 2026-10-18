import type { CommittedManeuver, Conjunction, ScreenResponse } from '../types/api';

/** The soonest thing ahead on the sandbox clock: a committed burn or a screened closest approach. */
export interface NextEvent {
  kind: 'burn' | 'tca';
  atUnix: number;
  id: string;
  label: string;
  /** A closest approach that still needs mitigation (CRITICAL/ELEVATED) or any burn. */
  critical: boolean;
}

export function nextEvent(screening: ScreenResponse | null | undefined, committed: CommittedManeuver[] | null | undefined, nowUnix: number): NextEvent | null {
  const events: NextEvent[] = [];
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

/** Something worth slowing down for: a committed burn or a close pass. */
export interface NearbyEvent {
  kind: 'burn' | 'tca';
  atUnix: number;
  id: string;
  missKm: number | null;
}

/**
 * The committed burn or close pass (miss within `maxMissKm`) nearest to `now` inside ± halfWindowS,
 * or null when nothing is that close in time.
 */
export function eventWithin(
  screening: ScreenResponse | null | undefined,
  committed: CommittedManeuver[] | null | undefined,
  nowUnix: number,
  halfWindowS: number,
  maxMissKm = Number.POSITIVE_INFINITY,
): NearbyEvent | null {
  let best: NearbyEvent | null = null;
  const consider = (e: NearbyEvent) => {
    const dt = Math.abs(e.atUnix - nowUnix);
    if (dt <= halfWindowS && (!best || dt < Math.abs(best.atUnix - nowUnix))) best = e;
  };
  for (const m of committed ?? []) consider({ kind: 'burn', atUnix: m.burn_time_unix, id: m.maneuver_id, missKm: null });
  for (const c of screening?.conjunctions ?? []) {
    if (c.miss_distance_km <= maxMissKm) consider({ kind: 'tca', atUnix: c.tca_unix, id: c.conjunction_id, missKm: c.miss_distance_km });
  }
  return best;
}
