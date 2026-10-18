import type { CommittedManeuver, ScreenResponse, ThreatState } from '../types/api';
import type { GhostCrash } from '../simulation/ghosts';

/** How far ahead the sandbox's look-ahead rail reaches: a little under two orbits, on round ticks. */
export const LOOK_AHEAD_S = 3 * 3600;
/** A pass at the screening radius draws a stub; a direct hit draws the full height. */
const RADIUS_KM = 25;
const MIN_HEIGHT = 0.25;

export type RailTone = 'threat' | 'watch' | 'clear';

export interface RailPass {
  kind: 'pass';
  id: string;
  /** 0 at now, 1 at the end of the rail. */
  x: number;
  atUnix: number;
  /** 0..1 bar height: closer passes stand taller. */
  height: number;
  tone: RailTone;
  name: string;
  missKm: number;
  state: ThreatState;
}

export interface RailBurn {
  kind: 'burn';
  id: string;
  x: number;
  atUnix: number;
  label: string;
}

export interface RailGhost {
  kind: 'ghost';
  id: string;
  x: number;
  atUnix: number;
  label: string;
}

export type RailMarker = RailPass | RailBurn | RailGhost;

export function passTone(state: ThreatState): RailTone {
  if (state === 'CRITICAL' || state === 'ELEVATED') return 'threat';
  if (state === 'MONITORING' || state === 'UNVERIFIED') return 'watch';
  return 'clear';
}

/**
 * What lies on the clock ahead, placed on a rail from now to now + horizon: every screened pass, every
 * committed burn not yet fired and every ghost collision still to come. Burns and ghosts draw over passes.
 */
export function railMarkers(
  screening: ScreenResponse | null | undefined,
  committed: CommittedManeuver[] | null | undefined,
  ghosts: GhostCrash[],
  nowUnix: number,
  horizonS = LOOK_AHEAD_S,
): RailMarker[] {
  const at = (t: number) => (t - nowUnix) / horizonS;
  const inside = (t: number) => t >= nowUnix && t <= nowUnix + horizonS;
  const out: RailMarker[] = [];
  for (const c of screening?.conjunctions ?? []) {
    if (!inside(c.tca_unix)) continue;
    const closeness = 1 - Math.min(c.miss_distance_km, RADIUS_KM) / RADIUS_KM;
    out.push({
      kind: 'pass',
      id: c.conjunction_id,
      x: at(c.tca_unix),
      atUnix: c.tca_unix,
      height: MIN_HEIGHT + (1 - MIN_HEIGHT) * closeness,
      tone: passTone(c.threat_state),
      name: c.secondary_name ?? c.secondary_id,
      missKm: c.miss_distance_km,
      state: c.threat_state,
    });
  }
  for (const m of committed ?? []) {
    if (!inside(m.burn_time_unix)) continue;
    out.push({ kind: 'burn', id: m.maneuver_id, x: at(m.burn_time_unix), atUnix: m.burn_time_unix, label: `${m.direction} ${m.dv_magnitude_mps.toFixed(2)} m/s` });
  }
  for (const g of ghosts) {
    if (!inside(g.atUnix)) continue;
    out.push({ kind: 'ghost', id: g.id, x: at(g.atUnix), atUnix: g.atUnix, label: g.label });
  }
  const layer = { pass: 0, burn: 1, ghost: 2 } as const;
  return out.sort((a, b) => layer[a.kind] - layer[b.kind] || a.atUnix - b.atUnix);
}

/** Where the screened stretch ends on the rail (0..1), or null when the whole rail has been screened. */
export function screenedUntil(screeningEndUnix: number | null, nowUnix: number, horizonS = LOOK_AHEAD_S): number | null {
  if (screeningEndUnix === null) return null;
  const x = (screeningEndUnix - nowUnix) / horizonS;
  return x >= 1 ? null : Math.max(0, x);
}

/** "+45m", "+1h", "+1h30m": a tick label for an offset from now. */
export function offsetLabel(s: number): string {
  const m = Math.round(s / 60);
  if (m === 0) return 'now';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h === 0 ? `+${r}m` : r === 0 ? `+${h}h` : `+${h}h${String(r).padStart(2, '0')}`;
}
