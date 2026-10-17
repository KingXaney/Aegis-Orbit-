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

export type PartColor =
  | 'module' | 'truss' | 'radiator' | 'issArray' | 'array' | 'mli' | 'antenna' | 'stage' | 'nozzle' | 'debris' | 'debrisDark'
  | 'cell' | 'panelFrame' | 'mliSilver' | 'deck' | 'baffle' | 'lens' | 'hinge';

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
  cell: '#14245c', // triple-junction cells
  panelFrame: '#aeb4bf',
  mliSilver: '#c9ccd3',
  deck: '#9aa1ab',
  baffle: '#16181d',
  lens: '#0a0f1e',
  hinge: '#6b7280',
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

/**
 * Earth-observing smallsat: gold-MLI bus with white radiators fore and aft, a nadir instrument and
 * high-gain dish, zenith star trackers and GPS antenna, aft thrusters, and two deployable wings of
 * three hinged panels each, every panel carrying a grid of cells on its sun (zenith) face.
 */
function boxWingBus(L: number, W: number, H: number): Part[] {
  const nadirH = 0.12 * H; // instrument and dish below the bus
  const zenithH = 0.06 * H; // star trackers and antennas above the bus
  const busZ = H - nadirH - zenithH;
  const busY = Math.min(0.22 * W, Math.max(L, busZ));
  const busX = 0.92 * L; // radiators and thrusters stand proud of the bus fore and aft
  const bottom = -H / 2 + nadirH;
  const top = bottom + busZ;
  const zc = (bottom + top) / 2;
  const m = Math.min(busX, busY); // reference size for bus-mounted hardware
  const deckT = 0.02 * busZ;
  const parts: Part[] = [
    // Structure decks top and bottom with the MLI-wrapped body between them, inset so no two
    // parts share a face (shared faces z-fight).
    box([0, 0, top - deckT / 2], [busX, busY, deckT], 'mliSilver'),
    box([0, 0, bottom + deckT / 2], [busX, busY, deckT], 'deck'),
    box([0, 0, zc], [0.98 * busX, 0.98 * busY, busZ - 2 * deckT], 'mli'),
  ];
  // radiators on the fore/aft faces
  for (const fore of [1, -1]) {
    parts.push(box([fore * (busX / 2 + 0.01 * L), 0, zc], [0.02 * L, 0.8 * busY, 0.7 * busZ], 'radiator'));
  }
  // aft thrusters at the four corners of the aft face, clear of the radiator
  for (const y of [1, -1]) {
    for (const z of [1, -1]) {
      parts.push(cyl([-busX / 2 - 0.02 * L, y * 0.43 * busY, zc + z * 0.43 * busZ], 'x', 0.04 * L, 0.025 * m, 'nozzle', 0.05 * m));
    }
  }
  // nadir instrument: telescope barrel with a dark aperture
  const scopeR = 0.2 * m;
  parts.push(cyl([0.12 * busX, 0, bottom - nadirH / 2], 'z', nadirH * 0.96, scopeR, 'mliSilver'));
  parts.push(cyl([0.12 * busX, 0, -H / 2 + 0.01 * nadirH], 'z', 0.02 * nadirH, 0.85 * scopeR, 'lens'));
  // high-gain dish on a short mast at the aft-nadir corner (cone opening toward nadir)
  const dishR = 0.16 * m;
  parts.push(box([-0.3 * busX, 0.25 * busY, bottom - 0.3 * nadirH], [0.03 * m, 0.03 * m, 0.6 * nadirH], 'hinge'));
  parts.push(cyl([-0.3 * busX, 0.25 * busY, -H / 2 + 0.2 * nadirH], 'z', 0.4 * nadirH, 0.15 * dishR, 'antenna', dishR));
  // zenith: two star trackers with black baffles, GPS patch, sun sensors
  for (const y of [1, -1]) {
    parts.push(cyl([-0.25 * busX, y * 0.25 * busY, top + zenithH / 2], 'z', zenithH, 0.09 * m, 'baffle', 0.06 * m));
  }
  parts.push(cyl([0.25 * busX, 0, top + 0.15 * zenithH], 'z', 0.3 * zenithH, 0.12 * m, 'antenna'));
  for (const x of [1, -1]) parts.push(box([x * 0.4 * busX, 0, top + 0.2 * zenithH], [0.05 * m, 0.05 * m, 0.4 * zenithH], 'baffle'));

  // deployable wings
  const span = (W - busY) / 2;
  const yoke = 0.1 * span;
  const gap = 0.012 * span;
  const panels = 3;
  const panelSpan = (span - yoke - gap * panels) / panels;
  const panelX = 0.85 * L;
  const t = Math.max(0.015, 0.01 * L); // panel thickness
  const cellsX = 8;
  const cellsY = 6;
  for (const side of [1, -1]) {
    const root = busY / 2;
    // yoke: two struts from the bus side to the inboard panel, plus the drive at the bus wall
    parts.push(box([0, side * (root + 0.02 * span), zc], [0.12 * L, 0.04 * span, 0.12 * L], 'hinge'));
    for (const x of [1, -1]) {
      parts.push(box([x * 0.3 * panelX, side * (root + yoke / 2), zc], [0.03 * L, yoke, 0.03 * L], 'panelFrame'));
    }
    for (let i = 0; i < panels; i++) {
      const y0 = root + yoke + gap / 2 + i * (panelSpan + gap);
      const yc = side * (y0 + panelSpan / 2);
      parts.push(box([0, yc, zc], [panelX, panelSpan, t], 'panelFrame'));
      // cells on the sun face, standing clear of the substrate, which shows between them
      const pitchX = (0.96 * panelX) / cellsX;
      const pitchY = (0.94 * panelSpan) / cellsY;
      for (let cx = 0; cx < cellsX; cx++) {
        for (let cy = 0; cy < cellsY; cy++) {
          parts.push(box(
            [-0.48 * panelX + (cx + 0.5) * pitchX, yc - side * 0.47 * panelSpan + side * (cy + 0.5) * pitchY, zc + 0.5 * t + 0.125 * t],
            [0.92 * pitchX, 0.9 * pitchY, 0.25 * t],
            'cell',
          ));
        }
      }
      // hinges to the next panel (or the yoke)
      for (const x of [1, -1]) {
        parts.push(box([x * 0.3 * panelX, side * (y0 - gap / 2), zc], [0.04 * L, gap * 1.6, 1.4 * t], 'hinge'));
      }
    }
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
