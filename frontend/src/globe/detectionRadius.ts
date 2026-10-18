import * as Cesium from 'cesium';

// The primary's detection radii, drawn at true scale around the spacecraft: the screening radius (a
// conjunction is reported when another object's miss distance is under it) and, inside it, the
// miss-distance target (closer than that, the pass needs a maneuver). Each shell lights up while an
// object is inside it: amber for the screening shell, red for the critical one.

type Vec3 = { x: number; y: number; z: number };

export interface DetectionRadii {
  screeningKm: number;
  criticalKm: number;
}

export type Intrusion = 'clear' | 'screening' | 'critical';

// backend/app/config.py defaults, for a scenario whose thresholds lack them
const DEFAULT_SCREENING_KM = 25;
const DEFAULT_CRITICAL_KM = 5;

const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** The radii from a scenario's `thresholds` (screening_radius_km, miss_distance_target_km). */
export function detectionRadii(thresholds: Record<string, unknown> | undefined): DetectionRadii {
  const screeningKm = positive(thresholds?.screening_radius_km) ?? DEFAULT_SCREENING_KM;
  const criticalKm = Math.min(positive(thresholds?.miss_distance_target_km) ?? DEFAULT_CRITICAL_KM, screeningKm);
  return { screeningKm, criticalKm };
}

/** Which shell the nearest object is inside, from positions in metres in one frame. */
export function intrusion(primary: Vec3 | undefined, others: Iterable<Vec3 | undefined>, radii: DetectionRadii): Intrusion {
  if (!primary) return 'clear';
  let nearestM = Infinity;
  for (const o of others) {
    if (!o) continue;
    nearestM = Math.min(nearestM, Math.hypot(o.x - primary.x, o.y - primary.y, o.z - primary.z));
  }
  if (nearestM < radii.criticalKm * 1000) return 'critical';
  if (nearestM < radii.screeningKm * 1000) return 'screening';
  return 'clear';
}

const COLORS = {
  screening: Cesium.Color.fromCssColorString('#67e8f9'), // --color-primary
  caution: Cesium.Color.fromCssColorString('#fbbf24'), // --color-warn
  critical: Cesium.Color.fromCssColorString('#f87171'), // --color-threat
};

export interface DetectionRadiusOptions {
  /** The primary's entity: the shells follow its position, and it is left out of the intrusion check. */
  primary: Cesium.Entity;
  thresholds: Record<string, unknown> | undefined;
  /** Every object entity in the scene, read each frame. */
  objects: () => Iterable<Cesium.Entity>;
  show: () => boolean;
  showLabels: () => boolean;
  /**
   * Close-up views: draw a bubble of this radius (metres) around the spacecraft instead of the
   * true-scale shells, which would surround the camera there. It shows the same state.
   */
  bubbleRadiusM?: number;
}

/** Adds both shells and their labels to `entities`; removing the collection's entities removes them. */
export function addDetectionRadius(entities: Cesium.EntityCollection, opts: DetectionRadiusOptions): void {
  const radii = detectionRadii(opts.thresholds);
  const position = opts.primary.position!;

  // One intrusion check per rendered time, shared by every colour callback below.
  let checkedAt: Cesium.JulianDate | undefined;
  let state: Intrusion = 'clear';
  const current = (time: Cesium.JulianDate | undefined): Intrusion => {
    if (!time || (checkedAt && Cesium.JulianDate.equals(checkedAt, time))) return state;
    checkedAt = Cesium.JulianDate.clone(time, checkedAt);
    const others: (Cesium.Cartesian3 | undefined)[] = [];
    for (const e of opts.objects()) if (e !== opts.primary) others.push(e.position?.getValue(time));
    state = intrusion(position.getValue(time), others, radii);
    return state;
  };
  const color = (pick: (s: Intrusion) => Cesium.Color) => new Cesium.CallbackProperty((t) => pick(current(t)), false);
  const show = new Cesium.CallbackProperty(opts.show, false);
  const showLabel = new Cesium.CallbackProperty(() => opts.show() && opts.showLabels(), false);

  if (opts.bubbleRadiusM !== undefined) {
    const r = opts.bubbleRadiusM;
    entities.add({
      id: 'detection:bubble',
      position,
      ellipsoid: {
        radii: new Cesium.Cartesian3(r, r, r),
        material: new Cesium.ColorMaterialProperty(color((s) =>
          s === 'critical' ? COLORS.critical.withAlpha(0.3) : s === 'screening' ? COLORS.caution.withAlpha(0.2) : COLORS.screening.withAlpha(0.08))),
        show,
      },
    });
    return;
  }

  const shell = (id: string, km: number, fill: (s: Intrusion) => Cesium.Color, outline: (s: Intrusion) => Cesium.Color, label: string, labelColor: Cesium.Color) => {
    const r = km * 1000;
    entities.add({
      id: `detection:${id}`,
      position,
      ellipsoid: {
        radii: new Cesium.Cartesian3(r, r, r),
        material: new Cesium.ColorMaterialProperty(color(fill)),
        outline: true,
        outlineColor: color(outline),
        // a sparse grid: the follow camera sits inside both shells, where a dense one would cage the view
        slicePartitions: 12,
        stackPartitions: 6,
        show,
      },
    });
    // The label sits on top of its shell, straight above the spacecraft.
    const top = new Cesium.CallbackPositionProperty((time, result) => {
      const p = time ? position.getValue(time, result) : undefined;
      if (!p) return undefined;
      const up = Cesium.Cartesian3.normalize(p, new Cesium.Cartesian3());
      return Cesium.Cartesian3.add(p, Cesium.Cartesian3.multiplyByScalar(up, r, up), p);
    }, false, Cesium.ReferenceFrame.FIXED);
    entities.add({
      id: `detection:${id}:label`,
      position: top,
      label: {
        text: label,
        font: '11px "JetBrains Mono", Menlo, monospace',
        fillColor: labelColor,
        style: Cesium.LabelStyle.FILL,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#0b1220').withAlpha(0.7),
        backgroundPadding: new Cesium.Cartesian2(5, 3),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        // only where the shells are big enough on screen to read
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 40 * r),
        show: showLabel,
      },
    });
  };

  shell(
    'screening',
    radii.screeningKm,
    (s) => (s === 'clear' ? COLORS.screening.withAlpha(0.04) : COLORS.caution.withAlpha(0.08)),
    (s) => (s === 'clear' ? COLORS.screening.withAlpha(0.3) : COLORS.caution.withAlpha(0.7)),
    `${radii.screeningKm} km screening radius`,
    COLORS.screening,
  );
  shell(
    'critical',
    radii.criticalKm,
    (s) => COLORS.critical.withAlpha(s === 'critical' ? 0.22 : 0.06),
    (s) => COLORS.critical.withAlpha(s === 'critical' ? 0.95 : 0.45),
    `${radii.criticalKm} km critical radius`,
    COLORS.critical,
  );
}
