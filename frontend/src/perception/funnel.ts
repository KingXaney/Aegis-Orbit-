import type { PerceptionFunnel, PerceptionObject, PerceptionResponse } from './types';

// The ML perception funnel as the mission page plays it: every tracked object -> the ones the model
// flags -> the ones physics screens (the model's top K plus the near-altitude safety band) -> the passes
// physics confirms -> the ones inside the critical radius. Pure functions: the panel, the point cloud
// and the tests share them.

export const FUNNEL_STEPS = ['tracked', 'flagged', 'screened', 'confirmed', 'critical'] as const;
export type FunnelStepKey = (typeof FUNNEL_STEPS)[number];
/** The last step played: IDLE before a run (every object looks alike), then 0..4 as the funnel plays. */
export const IDLE = -1;
export const STEP = { tracked: 0, flagged: 1, screened: 2, confirmed: 3, critical: 4 } as const;
export const LAST_STEP = FUNNEL_STEPS.length - 1;

export interface FunnelRow {
  key: FunnelStepKey;
  label: string;
  count: number;
  detail: string;
}

const n = (x: number) => x.toLocaleString('en-US');

/** `injected`: drill objects among the tracked ones (the backend counts them with the catalog). */
export function funnelRows(f: PerceptionFunnel, r: PerceptionResponse, injected = 0): FunnelRow[] {
  const trackedKm = r.thresholds.tracked_radius_km;
  const criticalKm = r.thresholds.critical_radius_km;
  const sl = f.shortlist;
  const scoreMs = Math.max(1, Math.round(r.stats.score_duration_s * 1000));
  const drill = injected > 0 ? ` (+${injected} injected drill)` : '';
  return [
    { key: 'tracked', label: 'Tracked objects', count: f.tracked, detail: `public CelesTrak catalog from ground tracking, propagated with SGP4${drill}` },
    {
      key: 'flagged',
      label: 'Flagged by the ML model',
      count: f.ml_flagged,
      detail: `${n(f.ml_scored)} scored in ${scoreMs} ms · risk score ≥ ${(f.threshold ?? 0).toFixed(3)}`,
    },
    {
      key: 'screened',
      label: 'Checked with physics',
      count: f.screened,
      detail: sl
        ? `model's top ${sl.ml_top_k} + ${sl.band_count} within ${sl.band_margin_km} km of the station's altitude`
        : 'every object (the catalog is small enough to screen in full)',
    },
    {
      key: 'confirmed',
      label: 'Confirmed close passes',
      count: f.passes,
      detail: `inside ${trackedKm} km · ${f.confirmed_ids.length} object${f.confirmed_ids.length === 1 ? '' : 's'}`,
    },
    { key: 'critical', label: 'Inside the critical radius', count: f.critical_ids.length, detail: `closer than ${criticalKm} km: the operator decides` },
  ];
}

// Membership bits per object (one byte each for ~19k points).
export const FLAGGED = 1;
export const SCREENED = 2;
export const CONFIRMED = 4;
export const CRITICAL = 8;

export function membershipBits(ids: readonly string[], f: PerceptionFunnel | null): Uint8Array {
  const bits = new Uint8Array(ids.length);
  if (!f) return bits;
  const index = new Map(ids.map((id, i) => [id, i] as const));
  const mark = (list: readonly string[], bit: number) => {
    for (const id of list) {
      const i = index.get(id);
      if (i !== undefined) bits[i] |= bit;
    }
  };
  mark(f.flagged_ids, FLAGGED);
  mark(f.screened_ids, SCREENED);
  mark(f.confirmed_ids, CONFIRMED);
  mark(f.critical_ids, CRITICAL);
  return bits;
}

/** How a cloud point looks at a funnel step: a colour role, an opacity and a pixel size (null = hidden). */
export type ColorRole = 'tracked' | 'flagged' | 'screened' | 'confirmed' | 'critical';
export interface PointStyle {
  role: ColorRole;
  alpha: number;
  size: number;
}

const BASE: PointStyle = { role: 'tracked', alpha: 0.5, size: 2 };
const FADED: PointStyle = { role: 'tracked', alpha: 0.07, size: 1.5 };
const GONE: PointStyle = { role: 'tracked', alpha: 0.035, size: 1.5 };

/**
 * `drawnAsEntity`: the object also has a globe entity (the confirmed passes, from the confirmed step on),
 * so its cloud point hides rather than doubling up.
 */
export function pointStyle(bits: number, step: number, drawnAsEntity = false): PointStyle | null {
  if (step <= STEP.tracked) return BASE;
  if (step === STEP.flagged) return bits & FLAGGED ? { role: 'flagged', alpha: 0.95, size: 3.5 } : FADED;
  if (step === STEP.screened) {
    if (bits & SCREENED) return { role: 'screened', alpha: 0.95, size: 3.5 };
    return bits & FLAGGED ? { role: 'flagged', alpha: 0.3, size: 2 } : FADED;
  }
  if (bits & CONFIRMED) {
    if (drawnAsEntity) return null;
    return step >= STEP.critical && bits & CRITICAL ? { role: 'critical', alpha: 1, size: 6 } : { role: 'confirmed', alpha: 1, size: 5 };
  }
  return bits & SCREENED ? { role: 'screened', alpha: 0.25, size: 2 } : GONE;
}

export type Verdict =
  | { kind: 'stay'; closest: PerceptionObject | null; criticalKm: number }
  | { kind: 'alert'; threats: PerceptionObject[]; criticalKm: number };

/** The operator's recommendation: an alert for every pass inside the critical radius, else stay on course. */
export function verdictFor(r: PerceptionResponse): Verdict {
  const criticalKm = r.thresholds.critical_radius_km;
  const byTime = (a: PerceptionObject, b: PerceptionObject) => (a.physics.tca_unix ?? Infinity) - (b.physics.tca_unix ?? Infinity);
  const threats = r.objects.filter((o) => o.tier === 'CRITICAL').sort(byTime);
  if (threats.length > 0) return { kind: 'alert', threats, criticalKm };
  const passes = r.objects.filter((o) => o.tier === 'SEMI_CRITICAL' && o.physics.miss_distance_km !== null);
  passes.sort((a, b) => (a.physics.miss_distance_km ?? 0) - (b.physics.miss_distance_km ?? 0));
  return { kind: 'stay', closest: passes[0] ?? null, criticalKm };
}
