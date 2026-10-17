import type { Vec3 } from '../simulation/trajectory';
import type { Conjunction, ObjectSummary, PerceptionObject, PerceptionSnapshot, PerceptionTier, ScenarioDetail, ScreenResponse, ThreatState } from '../types/api';
import { DEFAULT_THRESHOLDS, encounterPlaneOffset, type EncounterThresholds } from './encounterMap';
import { relativeStateRtn } from './rtn';
import { tierFromMiss } from './tiers';

export interface EncounterItem {
  id: string;
  objectId: string;
  name: string;
  category: string;
  tier: PerceptionTier;
  conjunctionId: string | null;
  tcaUnix: number | null;
  missKm: number | null;
  relSpeedKms: number | null;
  missRtn: Vec3 | null;
  vRelRtn: Vec3 | null;
  offset: { x: number; y: number; L: Vec3; U: Vec3 } | null;
  threatState: ThreatState | null;
  pc: { status: string; value: number | null; covariance_basis: string } | null;
  mlScore: number | null;
  mlPredicted: string | null;
  verified: boolean;
  status: string;
  trail: { timesUnix: number[]; rtnKm: Vec3[] } | null;
  mitigated: boolean;
  postMissKm: number | null;
  postTier: PerceptionTier | null;
}

export interface BuildArgs {
  perception: PerceptionSnapshot | null;
  perceptionManeuvered: PerceptionSnapshot | null;
  screening: ScreenResponse | null;
  objects: Record<string, ObjectSummary>;
  scenario: ScenarioDetail | null;
}

export interface BuildResult {
  items: EncounterItem[];
  thresholds: EncounterThresholds;
  basis: 'perception' | 'screening' | 'none';
}

const MATCH_S = 600;

function asVec(a: number[] | null | undefined): Vec3 | null {
  return a && a.length === 3 && a.every((x) => Number.isFinite(x)) ? [a[0], a[1], a[2]] : null;
}

/** Defensive normalisation of the perception payload (tolerates missing optional blocks). */
export function normalizePerception(raw: unknown): PerceptionSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<PerceptionSnapshot> & { objects?: unknown };
  const objects = Array.isArray(r.objects) ? (r.objects as PerceptionObject[]) : [];
  return { ...(r as PerceptionSnapshot), objects: objects.filter((o) => o && typeof o.object_id === 'string' && o.physics) };
}

/** Client-side RTN miss vector and co-moving relative velocity from a screening conjunction. */
export function conjunctionToRtn(c: Conjunction): { missRtn: Vec3; vRelRtn: Vec3 } {
  const p = { p: c.primary_state_teme.r_km as Vec3, v: c.primary_state_teme.v_kms as Vec3 };
  const s = { p: c.secondary_state_teme.r_km as Vec3, v: c.secondary_state_teme.v_kms as Vec3 };
  const rel = relativeStateRtn(p, s);
  return { missRtn: rel.r, vRelRtn: rel.v };
}

function thresholdsFrom(perception: PerceptionSnapshot | null, scenario: ScenarioDetail | null): EncounterThresholds {
  const thr = perception?.thresholds;
  const scen = (scenario?.thresholds ?? {}) as Record<string, unknown>;
  const period = scenario ? (Object.values(scenario.data_source).length, 5578) : 5578;
  const windowS = scenario ? scenario.window.end_unix - scenario.window.start_unix : 2 * period;
  return {
    criticalKm: thr?.critical_radius_km ?? (typeof scen.miss_distance_target_km === 'number' ? scen.miss_distance_target_km : DEFAULT_THRESHOLDS.criticalKm),
    trackedKm: thr?.tracked_radius_km ?? (typeof scen.screening_radius_km === 'number' ? scen.screening_radius_km : DEFAULT_THRESHOLDS.trackedKm),
    horizonS: thr?.horizon_s ?? Math.max(windowS, 2 * period),
    nearFieldS: thr?.near_field_horizon_s ?? DEFAULT_THRESHOLDS.nearFieldS,
  };
}

function itemFromPerception(o: PerceptionObject): EncounterItem {
  const ph = o.physics;
  const missRtn = asVec(ph.miss_vector_rtn_km);
  const vRelRtn = asVec(ph.relative_velocity_rtn_kms);
  const offset = missRtn && vRelRtn ? encounterPlaneOffset(missRtn, vRelRtn) : null;
  return {
    id: ph.conjunction_id ?? `obj:${o.object_id}`,
    objectId: o.object_id,
    name: o.name,
    category: o.category,
    tier: o.tier,
    conjunctionId: ph.conjunction_id,
    tcaUnix: ph.tca_unix,
    missKm: ph.miss_distance_km,
    relSpeedKms: ph.relative_speed_kms,
    missRtn,
    vRelRtn,
    offset: offset ? { x: offset.x, y: offset.y, L: offset.L, U: offset.U } : null,
    threatState: ph.threat_state,
    pc: ph.pc ? { status: ph.pc.status, value: ph.pc.value, covariance_basis: ph.pc.covariance_basis } : null,
    mlScore: o.ml?.score ?? null,
    mlPredicted: o.ml?.predicted_tier ?? null,
    verified: ph.verified,
    status: ph.status,
    trail: o.trail ? { timesUnix: o.trail.times_unix, rtnKm: o.trail.positions_rtn_km.map((p) => [p[0], p[1], p[2]] as Vec3) } : null,
    mitigated: false,
    postMissKm: null,
    postTier: null,
  };
}

function itemFromConjunction(c: Conjunction, objects: Record<string, ObjectSummary>, thr: EncounterThresholds): EncounterItem | null {
  const tier = tierFromMiss(c.miss_distance_km, thr) ?? (c.threat_state === 'CRITICAL' || c.threat_state === 'ELEVATED' ? 'CRITICAL' : null);
  if (!tier) return null;
  const { missRtn, vRelRtn } = conjunctionToRtn(c);
  const offset = encounterPlaneOffset(missRtn, vRelRtn);
  const pcComputed = c.pc?.status === 'COMPUTED' && c.pc.value !== null;
  const finalTier: PerceptionTier = pcComputed ? (c.threat_state === 'CRITICAL' || c.threat_state === 'ELEVATED' ? 'CRITICAL' : 'SEMI_CRITICAL') : tier;
  return {
    id: c.conjunction_id,
    objectId: c.secondary_id,
    name: c.secondary_name ?? objects[c.secondary_id]?.name ?? c.secondary_id,
    category: c.secondary_category ?? objects[c.secondary_id]?.category ?? 'UNKNOWN',
    tier: finalTier,
    conjunctionId: c.conjunction_id,
    tcaUnix: c.tca_unix,
    missKm: c.miss_distance_km,
    relSpeedKms: c.relative_speed_kms,
    missRtn,
    vRelRtn,
    offset: { x: offset.x, y: offset.y, L: offset.L, U: offset.U },
    threatState: c.threat_state,
    pc: c.pc ? { status: c.pc.status, value: c.pc.value, covariance_basis: c.pc.covariance_basis } : null,
    mlScore: null,
    mlPredicted: null,
    verified: true,
    status: 'CONJUNCTION',
    trail: null,
    mitigated: false,
    postMissKm: null,
    postTier: null,
  };
}

function applyManeuvered(items: EncounterItem[], maneuvered: PerceptionSnapshot | null): void {
  if (!maneuvered) return;
  for (const it of items) {
    if (it.tcaUnix === null) continue;
    const match = maneuvered.objects.find((o) => o.object_id === it.objectId && o.physics.tca_unix !== null
      && (o.physics.linked_conjunction_id === it.conjunctionId || Math.abs((o.physics.tca_unix ?? 0) - (it.tcaUnix ?? 0)) <= MATCH_S));
    if (!match) continue;
    it.postMissKm = match.physics.miss_distance_km;
    it.postTier = match.tier;
    it.mitigated = it.tier === 'CRITICAL' && match.tier !== 'CRITICAL';
  }
}

export function buildEncounters(args: BuildArgs): BuildResult {
  const thresholds = thresholdsFrom(args.perception, args.scenario);
  if (args.perception && args.perception.objects.length > 0) {
    const items = args.perception.objects.filter((o) => o.tier !== 'HIDDEN').map(itemFromPerception);
    applyManeuvered(items, args.perceptionManeuvered);
    return { items, thresholds, basis: 'perception' };
  }
  if (args.screening && args.screening.conjunctions.length > 0) {
    const items = args.screening.conjunctions.map((c) => itemFromConjunction(c, args.objects, thresholds)).filter((x): x is EncounterItem => x !== null);
    applyManeuvered(items, args.perceptionManeuvered);
    return { items, thresholds, basis: 'screening' };
  }
  return { items: [], thresholds, basis: args.perception ? 'perception' : 'none' };
}
