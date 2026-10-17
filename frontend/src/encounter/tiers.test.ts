import { describe, expect, it } from 'vitest';
import { styleFor, tierFromMiss } from './tiers';

describe('tiers', () => {
  it('maps miss distance to tiers with the configured radii', () => {
    const thr = { criticalKm: 5, trackedKm: 25 };
    expect(tierFromMiss(0.354, thr)).toBe('CRITICAL');
    expect(tierFromMiss(6.3, thr)).toBe('SEMI_CRITICAL');
    expect(tierFromMiss(30, thr)).toBeNull();
    expect(tierFromMiss(NaN, thr)).toBeNull();
  });

  it('styles tiers and modifiers', () => {
    expect(styleFor('CRITICAL').outline).toBe('#ef4444');
    expect(styleFor('CRITICAL').pulse).toBe(true);
    expect(styleFor('CRITICAL', { reducedMotion: true }).pulse).toBe(false);
    expect(styleFor('CRITICAL', { mitigated: true }).outline).toBe('#4ade80');
    expect(styleFor('CRITICAL', { mitigated: true }).pulse).toBe(false);
    expect(styleFor('SEMI_CRITICAL').outline).toBeNull();
    expect(styleFor('SEMI_CRITICAL', { selected: true }).outline).toBe('#67e8f9');
    expect(styleFor('ML_WATCH').fillOpacity).toBeLessThan(styleFor('SEMI_CRITICAL').fillOpacity);
  });
});
