import { describe, expect, it } from 'vitest';
import { detectionRadii, intrusion } from './detectionRadius';

describe('detectionRadii', () => {
  it('reads the screening radius and the miss-distance target from the scenario thresholds', () => {
    expect(detectionRadii({ screening_radius_km: 30, miss_distance_target_km: 2 })).toEqual({ screeningKm: 30, criticalKm: 2 });
  });

  it("falls back to the backend's defaults when a threshold is missing or not a positive number", () => {
    expect(detectionRadii({})).toEqual({ screeningKm: 25, criticalKm: 5 });
    expect(detectionRadii(undefined)).toEqual({ screeningKm: 25, criticalKm: 5 });
    expect(detectionRadii({ screening_radius_km: 'far', miss_distance_target_km: -1 })).toEqual({ screeningKm: 25, criticalKm: 5 });
  });

  it('never puts the critical shell outside the screening shell', () => {
    expect(detectionRadii({ screening_radius_km: 3, miss_distance_target_km: 5 })).toEqual({ screeningKm: 3, criticalKm: 3 });
  });
});

describe('intrusion', () => {
  const radii = { screeningKm: 25, criticalKm: 5 };
  const primary = { x: 6_778_000, y: 0, z: 0 };
  const at = (km: number) => ({ x: 6_778_000, y: km * 1000, z: 0 });

  it('is clear when every object is outside the screening radius', () => {
    expect(intrusion(primary, [at(40), at(-26)], radii)).toBe('clear');
  });

  it('is screening when the nearest object is inside 25 km but outside 5 km', () => {
    expect(intrusion(primary, [at(40), at(12)], radii)).toBe('screening');
  });

  it('is critical when any object is inside the critical radius', () => {
    expect(intrusion(primary, [at(12), at(0.354)], radii)).toBe('critical');
  });

  it('ignores objects without a position and is clear with no objects or no primary', () => {
    expect(intrusion(primary, [undefined, at(30)], radii)).toBe('clear');
    expect(intrusion(primary, [], radii)).toBe('clear');
    expect(intrusion(undefined, [at(1)], radii)).toBe('clear');
  });
});
