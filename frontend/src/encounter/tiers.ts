import type { PerceptionTier } from '../types/api';

export interface TierStyle {
  fill: string;
  fillOpacity: number;
  edge: string;
  edgeOpacity: number;
  outline: string | null;
  pulse: boolean;
  /** map-mode box size in scene units (w across the road, l along it, h tall) */
  size: { w: number; l: number; h: number };
  /** chase-mode box edge length in km (fixed, schematic) */
  chaseSizeKm: number;
  labelMode: 'always' | 'hover';
}

export interface StyleOptions {
  selected?: boolean;
  mitigated?: boolean;
  reducedMotion?: boolean;
}

export const TIER_COLORS: Record<PerceptionTier, string> = {
  CRITICAL: '#3b82f6',
  SEMI_CRITICAL: '#2563eb',
  ML_WATCH: '#1e3a8a',
  HIDDEN: '#0f172a',
};

export function styleFor(tier: PerceptionTier, opts: StyleOptions = {}): TierStyle {
  const base: TierStyle =
    tier === 'CRITICAL'
      ? { fill: '#3b82f6', fillOpacity: 0.55, edge: '#93c5fd', edgeOpacity: 0.9, outline: '#ef4444', pulse: true,
          size: { w: 0.8, l: 1.6, h: 0.4 }, chaseSizeKm: 0.3, labelMode: 'always' }
      : tier === 'SEMI_CRITICAL'
        ? { fill: '#2563eb', fillOpacity: 0.45, edge: '#60a5fa', edgeOpacity: 0.7, outline: null, pulse: false,
            size: { w: 0.6, l: 1.2, h: 0.3 }, chaseSizeKm: 0.25, labelMode: 'hover' }
        : { fill: '#1e3a8a', fillOpacity: 0.3, edge: '#3b82f6', edgeOpacity: 0.35, outline: null, pulse: false,
            size: { w: 0.6, l: 1.2, h: 0.2 }, chaseSizeKm: 0.2, labelMode: 'hover' };
  if (opts.mitigated) {
    base.outline = '#4ade80';
    base.pulse = false;
  }
  if (opts.selected) {
    base.edgeOpacity = 1;
    base.outline = '#67e8f9';
    base.labelMode = 'always';
  }
  if (opts.reducedMotion) base.pulse = false;
  return base;
}

export interface TierThresholds {
  criticalKm: number;
  trackedKm: number;
}

/** Distance-only tiering used by the screening fallback (no probability available). */
export function tierFromMiss(km: number, thr: TierThresholds): PerceptionTier | null {
  if (!Number.isFinite(km)) return null;
  if (km < thr.criticalKm) return 'CRITICAL';
  if (km < thr.trackedKm) return 'SEMI_CRITICAL';
  return null;
}
