import type { SpacecraftDesign } from '../types/api';

/**
 * Part lists for the spacecraft designs the backend names (`design.design_id`). Each builder lays
 * the parts out at true scale inside the design's envelope, in metres, in the body frame the globe
 * uses: x in-track (along velocity), y cross-track, z radial (up). The envelope comes from the
 * backend: published dimensions, a scenario definition, or the hard-body radius (see `design.basis`).
 * This module is pure so the layouts can be unit-tested without WebGL.
 */

export type Vec3 = [number, number, number];
export type Axis = 'x' | 'y' | 'z';

export type PartColor = 'module' | 'truss' | 'radiator' | 'issArray' | 'array' | 'mli' | 'antenna' | 'stage' | 'nozzle' | 'debris' | 'debrisDark';

export type Part =
  | { kind: 'box'; center: Vec3; size: Vec3; color: PartColor }
  /** Cylinder or cone along `axis`; `radiusPos` is the radius at the +axis end. */
  | { kind: 'cylinder'; center: Vec3; axis: Axis; length: number; radiusPos: number; radiusNeg: number; color: PartColor };

export const PART_COLORS: Record<PartColor, string> = {
  module: '#e5e7eb',
  truss: '#9ca3af',
  radiator: '#f8fafc',
  issArray: '#b7791f',
  array: '#1e3a8a',
  mli: '#d4a853',
  antenna: '#f1f5f9',
  stage: '#cbd5e1',
  nozzle: '#475569',
  debris: '#94a3b8',
  debrisDark: '#64748b',
};

const box = (center: Vec3, size: Vec3, color: PartColor): Part => ({ kind: 'box', center, size, color });
const cyl = (center: Vec3, axis: Axis, length: number, radius: number, color: PartColor, radiusNeg = radius): Part => ({
  kind: 'cylinder', center, axis, length, radiusPos: radius, radiusNeg, color,
});

/** International Space Station: truss across track, solar wings fore and aft, module stack in-track. */
function iss(L: number, W: number, H: number): Part[] {
  const trussZ = 0.2 * H;
  const moduleZ = -0.02 * H;
  const moduleR = 0.105 * H; // ~4.2 m diameter pressurized modules
  const parts: Part[] = [
    box([0.02 * L, 0, trussZ], [0.05 * L, 0.92 * W, 0.14 * H], 'truss'), // integrated truss
    box([0.02 * L, 0, 0.38 * H], [0.012 * L, 0.012 * W, 0.24 * H], 'antenna'), // zenith antenna mast
    cyl([0.15 * L, 0, moduleZ], 'x', 0.5 * L, moduleR, 'module'), // US lab, nodes, airlock
    cyl([-0.3 * L, 0, moduleZ], 'x', 0.4 * L, 0.95 * moduleR, 'module'), // Russian segment (Zarya, Zvezda)
    cyl([0.38 * L, 0, moduleZ], 'y', 0.2 * W, moduleR, 'module'), // Node 2 with Columbus and Kibo
    box([0.38 * L, -0.14 * W, moduleZ], [0.06 * L, 0.06 * W, 0.15 * H], 'truss'), // Kibo exposed facility
    cyl([-0.25 * L, 0, -0.34 * H], 'z', 0.32 * H, 0.08 * H, 'module'), // docked Soyuz / Progress
  ];
  for (const side of [1, -1]) {
    // four solar array wings per truss end, extending fore and aft of the truss
    for (const y of [0.445, 0.325]) {
      for (const fore of [1, -1]) parts.push(box([fore * 0.25 * L, side * y * W, trussZ], [0.46 * L, 0.11 * W, 0.01 * H], 'issArray'));
    }
    parts.push(box([0.02 * L, side * 0.385 * W, trussZ], [0.06 * L, 0.02 * W, 0.2 * H], 'truss')); // array gimbals
    parts.push(box([0.02 * L, side * 0.16 * W, -0.12 * H], [0.03 * L, 0.12 * W, 0.5 * H], 'radiator')); // heat radiators
    parts.push(box([-0.42 * L, side * 0.1 * W, moduleZ], [0.04 * L, 0.13 * W, 0.01 * H], 'array')); // Zvezda arrays
  }
  return parts;
}

/** Bus with a nadir/zenith antenna and two deployable solar arrays on cross-track booms. */
function boxWingBus(L: number, W: number, H: number): Part[] {
  const busZ = 0.82 * H;
  const busY = Math.min(0.22 * W, Math.max(L, busZ));
  const busCenterZ = -H / 2 + busZ / 2;
  const gap = 0.03 * W;
  const arraySpan = (W - busY) / 2 - gap;
  const parts: Part[] = [
    box([0, 0, busCenterZ], [L, busY, busZ], 'mli'),
    cyl([0, 0, H / 2 - (H - busZ) / 2], 'z', H - busZ, 0.3 * Math.min(L, busY), 'antenna'),
  ];
  for (const side of [1, -1]) {
    parts.push(box([0, side * (busY / 2 + gap / 2), busCenterZ], [0.05 * L, gap, 0.05 * L], 'truss'));
    parts.push(box([0, side * (W / 2 - arraySpan / 2), busCenterZ], [0.85 * L, arraySpan, Math.max(0.02, 0.02 * H)], 'array'));
  }
  return parts;
}

/** Bus with body-mounted cells and a zenith antenna; used when the object type is unknown. */
function compactBus(L: number, W: number, H: number): Part[] {
  const busZ = 0.85 * H;
  return [
    box([0, 0, -H / 2 + busZ / 2], [L, W, busZ], 'mli'),
    cyl([0, 0, H / 2 - (H - busZ) / 2], 'z', H - busZ, 0.25 * Math.min(L, W), 'antenna'),
  ];
}

/** Spent upper stage tumbling along track: tank cylinder, engine bell aft. */
function rocketBody(L: number, W: number, H: number): Part[] {
  const r = Math.min(W, H) / 2;
  return [
    cyl([0.1 * L, 0, 0], 'x', 0.8 * L, r, 'stage'),
    cyl([-0.4 * L, 0, 0], 'x', 0.2 * L, 0.25 * r, 'nozzle', 0.6 * r),
  ];
}

/** Irregular cluster of bent plates: a break-up fragment. */
function debrisFragment(L: number, W: number, H: number): Part[] {
  return [
    box([-0.2 * L, -0.15 * W, -0.25 * H], [0.6 * L, 0.7 * W, 0.5 * H], 'debris'),
    box([0.2 * L, 0.15 * W, 0.15 * H], [0.6 * L, 0.7 * W, 0.4 * H], 'debrisDark'),
    box([0.1 * L, -0.3 * W, 0.3 * H], [0.3 * L, 0.2 * W, 0.4 * H], 'debris'),
  ];
}

const BUILDERS: Record<string, (L: number, W: number, H: number) => Part[]> = {
  iss,
  'box-wing-bus': boxWingBus,
  'compact-bus': compactBus,
  'rocket-body': rocketBody,
  'debris-fragment': debrisFragment,
};

export function designParts(design: SpacecraftDesign): Part[] {
  const build = BUILDERS[design.design_id] ?? compactBus;
  return build(design.length_m, design.width_m, design.height_m);
}

/** Axis-aligned bounds of a part list: [min, max]. */
export function partBounds(parts: Part[]): [Vec3, Vec3] {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    let half: Vec3;
    if (p.kind === 'box') half = [p.size[0] / 2, p.size[1] / 2, p.size[2] / 2];
    else {
      const r = Math.max(p.radiusPos, p.radiusNeg);
      half = [r, r, r];
      half['xyz'.indexOf(p.axis)] = p.length / 2;
    }
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p.center[i] - half[i]);
      max[i] = Math.max(max[i], p.center[i] + half[i]);
    }
  }
  return [min, max];
}
