import type { CommittedManeuver, Conjunction, ThreatState } from '../types/api';

// What the timeline marks: each detection (the moment an object crosses into the screening radius
// around the spacecraft) and each committed burn (where the spacecraft changes its path), plus the
// figures the efficiency strip shows.

export const DEFAULT_SCREENING_RADIUS_KM = 25;
// A committed burn's dodged pass is the same object's conjunction at its post-burn TCA (re-screening
// after the commit sees the new path, so the pass no longer reads as critical, or has left the radius
// altogether). Conjunction ids are CJ-<primary>-<object>-<rounded TCA>: without the TCA they name the pair.
const DODGE_MATCH_S = 120;
const pairOf = (conjunctionId: string) => conjunctionId.replace(/-\d+$/, '');
const samePass = (m: CommittedManeuver, c: Conjunction) =>
  pairOf(m.conjunction_id) === pairOf(c.conjunction_id) && Math.abs(m.post_tca_unix - c.tca_unix) < DODGE_MATCH_S;

export interface DetectionEvent {
  kind: 'detection';
  t: number;
  tcaUnix: number;
  conjunctionId: string;
  objectId: string;
  name: string;
  state: ThreatState;
  missKm: number;
  /** A committed burn dodged this pass. */
  dodged: boolean;
}

export interface BurnEvent {
  kind: 'burn';
  t: number;
  maneuverId: string;
  dvMps: number;
  direction: string;
  directionLabel: string;
  source: CommittedManeuver['source'];
}

export type TimelineEvent = DetectionEvent | BurnEvent;

/**
 * When an object crosses into the radius: straight-line relative motion through the closest approach,
 * which is accurate here because at 7–15 km/s the pass through 25 km lasts a few seconds.
 */
export function radiusEntryUnix(tcaUnix: number, missKm: number, relativeSpeedKms: number, radiusKm: number): number {
  if (!(relativeSpeedKms > 0) || missKm >= radiusKm) return tcaUnix;
  return tcaUnix - Math.sqrt(radiusKm * radiusKm - missKm * missKm) / relativeSpeedKms;
}

export function timelineEvents(conjunctions: Conjunction[], committed: CommittedManeuver[], radiusKm = DEFAULT_SCREENING_RADIUS_KM): TimelineEvent[] {
  const dodges = committed.filter((m) => m.meets_target);
  const detections: TimelineEvent[] = conjunctions.map((c) => ({
    kind: 'detection',
    t: radiusEntryUnix(c.tca_unix, c.miss_distance_km, c.relative_speed_kms, radiusKm),
    tcaUnix: c.tca_unix,
    conjunctionId: c.conjunction_id,
    objectId: c.secondary_id,
    name: c.secondary_name ?? c.secondary_id,
    state: c.threat_state,
    missKm: c.miss_distance_km,
    dodged: dodges.some((m) => samePass(m, c)),
  }));
  // dodged passes the burn moved out of the radius are gone from the screening, but keep their mark
  for (const m of dodges) {
    if (conjunctions.some((c) => samePass(m, c))) continue;
    detections.push({
      kind: 'detection', t: m.post_tca_unix, tcaUnix: m.post_tca_unix, conjunctionId: m.conjunction_id, objectId: '',
      name: 'dodged pass', state: m.post_threat_state, missKm: m.post_miss_distance_km, dodged: true,
    });
  }
  const burns: TimelineEvent[] = committed.map((m) => ({
    kind: 'burn',
    t: m.burn_time_unix,
    maneuverId: m.maneuver_id,
    dvMps: m.dv_magnitude_mps,
    direction: m.direction,
    directionLabel: m.direction_label,
    source: m.source,
  }));
  return [...detections, ...burns].sort((a, b) => a.t - b.t);
}

/** The first event strictly after `nowUnix`, or null. */
export function nextEvent(events: TimelineEvent[], nowUnix: number): TimelineEvent | null {
  return events.find((e) => e.t > nowUnix) ?? null;
}

export interface Efficiency {
  passes: number;
  objects: number;
  criticalLeft: number;
  dodged: number;
  totalDvMps: number;
  /** The closest dodged pass before its burn, and the closest of them after. */
  closestBeforeKm: number | null;
  closestAfterKm: number | null;
}

export function efficiency(conjunctions: Conjunction[], committed: CommittedManeuver[]): Efficiency {
  const dodges = committed.filter((m) => m.meets_target);
  const min = (xs: number[]) => (xs.length ? Math.min(...xs) : null);
  return {
    passes: conjunctions.length,
    objects: new Set(conjunctions.map((c) => c.secondary_id)).size,
    criticalLeft: conjunctions.filter((c) => c.threat_state === 'CRITICAL').length,
    dodged: dodges.length,
    totalDvMps: Math.round(committed.reduce((sum, m) => sum + m.dv_magnitude_mps, 0) * 1e6) / 1e6,
    closestBeforeKm: min(dodges.map((m) => m.screening_miss_distance_km)),
    closestAfterKm: min(dodges.map((m) => m.post_miss_distance_km)),
  };
}
