import * as Cesium from 'cesium';
import type { CatalogObject, CatalogObjectType, OrbitClass } from '../types/api';
import { buildEarthTexture } from './earthTexture';
import { MODEL_NORAD_ID } from './filters';
import { readPalette, type Palette } from './palette';
import { STRIDE, gmst, temeToFixed } from './propagation';

// Catalog globe. Every object is a point primitive positioned in TEME (metres); the point, polyline,
// marker and label collections share one model matrix, a rotation about Z by -GMST(now), so the whole
// population turns into the Earth-fixed frame with a single matrix per frame. Positions are
// extrapolated linearly from the worker's last 1 Hz state.

export interface ExplorerSceneCallbacks {
  onPick: (index: number | null) => void;
}

// Solid, anti-aliased dots (pixels). Debris is the most numerous, so it is the smallest and slightly
// translucent, which keeps dense shells from merging into a smear.
const SIZE: Record<CatalogObjectType, number> = { PAYLOAD: 4, DEBRIS: 2.5, ROCKET_BODY: 3 };
const ALPHA: Record<CatalogObjectType, number> = { PAYLOAD: 1, DEBRIS: 0.75, ROCKET_BODY: 0.9 };
const SELECTED_SIZE = 8;
// The model spacecraft: a magenta dot larger than the rest, a soft steady halo so it can be found at a
// glance, and two staggered ripples that grow and fade so one is always on screen.
const MODEL_SIZE = 6;
const HALO_SIZE = 14;
const PULSE_PERIOD_S = 2;
const PULSE_START_PX = 6;
const PULSE_END_PX = 34;
const DIMMED_ALPHA = 0.3;
const ROTATE_RAD_S = 0.05; // about one turn every two minutes
const IDLE_BEFORE_ROTATE_S = 10;
const INTRO_DELAY_S: Record<OrbitClass, number> = { LEO: 0, MEO: 0.35, HEO: 0.5, GEO: 0.7 };
const INTRO_GEO_SWEEP_S = 0.6;
const INTRO_FADE_S = 0.5;
// The opening view: Earth spans this share of the frame's shorter side, so LEO (where GPM flies) reads
// clearly and the sparser MEO and GEO objects sit around it.
const EARTH_FILL = 0.62;
const EARTH_RADIUS_M = Cesium.Ellipsoid.WGS84.maximumRadius;
const MAX_OPENING_LAT_DEG = 35;

function ringSprite(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const g = c.getContext('2d')!;
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(24, 24, 15, 0, Math.PI * 2);
  g.stroke();
  return c;
}

export class ExplorerScene {
  readonly viewer: Cesium.Viewer;
  private readonly callbacks: ExplorerSceneCallbacks;
  private readonly palette: Palette;
  private readonly colors: Record<CatalogObjectType, Cesium.Color>;
  private readonly model: Cesium.Color;
  private readonly points: Cesium.PointPrimitiveCollection;
  private readonly pulse: Cesium.PointPrimitiveCollection;
  private readonly pulseHalo: Cesium.PointPrimitive;
  private readonly pulseRings: Cesium.PointPrimitive[];
  private readonly markers: Cesium.BillboardCollection;
  private readonly paths: Cesium.PolylineCollection;
  private readonly labels: Cesium.LabelCollection;
  private readonly ring: Cesium.Billboard;
  private readonly hoverLabel: Cesium.Label;
  private readonly selectedLabel: Cesium.Label;
  private readonly handler: Cesium.ScreenSpaceEventHandler;
  private readonly removePreUpdate: Cesium.Event.RemoveCallback;
  private readonly reducedMotion: boolean;

  private objects: CatalogObject[] = [];
  private dots: Cesium.PointPrimitive[] = [];
  private modelIndex: number | null = null;
  private destroyed = false;
  private earthTextureUrl: string | null = null;
  private state: Float32Array | null = null;
  private stateUnix = 0;
  private mask: Uint8Array = new Uint8Array(0);
  private selected: number | null = null;
  private hovered: number | null = null;
  private introStart: number | null = null;
  private introDelay: Float32Array = new Float32Array(0);
  private lastInteraction = -Infinity;
  private lastFrame = performance.now() / 1000;
  private lastHoverPick = 0;
  private readonly rotation = new Cesium.Matrix4();
  private readonly scratchM3 = new Cesium.Matrix3();
  private readonly scratchPos = new Cesium.Cartesian3();
  private readonly scratchColor = new Cesium.Color();
  private readonly onInteract = () => {
    this.lastInteraction = performance.now() / 1000;
  };
  private readonly onPointerMove = (e: PointerEvent) => {
    if (e.buttons) this.onInteract();
  };

  constructor(container: HTMLElement, callbacks: ExplorerSceneCallbacks) {
    this.callbacks = callbacks;
    this.palette = readPalette();
    const css = (c: string) => Cesium.Color.fromCssColorString(c);
    this.colors = { PAYLOAD: css(this.palette.types.PAYLOAD), DEBRIS: css(this.palette.types.DEBRIS), ROCKET_BODY: css(this.palette.types.ROCKET_BODY) };
    this.model = css(this.palette.accent);
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    this.viewer = new Cesium.Viewer(container, {
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      infoBox: false,
      selectionIndicator: false,
      fullscreenButton: false,
      vrButton: false,
      skyBox: false,
      skyAtmosphere: false,
      baseLayer: false,
      shouldAnimate: true,
      // Render at the display's real pixel ratio (Cesium defaults to CSS pixels, which blurs on
      // high-DPI screens) and anti-alias geometry with MSAA instead of the softening FXAA pass.
      useBrowserRecommendedResolution: false,
      msaaSamples: 4,
    });
    const scene = this.viewer.scene;
    this.viewer.clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK;
    this.viewer.clock.shouldAnimate = true;
    // Evenly lit, no day/night shading: the globe is a backdrop for the objects.
    scene.globe.enableLighting = false;
    scene.globe.showGroundAtmosphere = false;
    scene.globe.baseColor = Cesium.Color.fromCssColorString(this.palette.ocean);
    scene.postProcessStages.fxaa.enabled = false;
    scene.backgroundColor = Cesium.Color.fromCssColorString(this.palette.bg);
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.fog.enabled = false;
    scene.highDynamicRange = false;
    scene.screenSpaceCameraController.minimumZoomDistance = 300_000;
    scene.screenSpaceCameraController.maximumZoomDistance = 150_000_000;

    // Added first so the ring draws beneath the dots.
    this.pulse = scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.pulseHalo = this.pulse.add({ position: new Cesium.Cartesian3(), pixelSize: HALO_SIZE, color: this.model.withAlpha(0.28), show: false });
    this.pulseRings = [0, 1].map(() =>
      this.pulse.add({ position: new Cesium.Cartesian3(), pixelSize: PULSE_START_PX, color: Cesium.Color.TRANSPARENT, outlineColor: this.model, outlineWidth: 2, show: false }),
    );
    this.points = scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.paths = scene.primitives.add(new Cesium.PolylineCollection());
    this.markers = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
    this.labels = scene.primitives.add(new Cesium.LabelCollection({ scene }));
    this.ring = this.markers.add({ position: new Cesium.Cartesian3(), image: ringSprite(), width: 30, height: 30, show: false, disableDepthTestDistance: Number.POSITIVE_INFINITY });
    const labelOptions = {
      position: new Cesium.Cartesian3(),
      font: '14px B612, sans-serif',
      fillColor: Cesium.Color.fromCssColorString(this.palette.text),
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString(this.palette.surface).withAlpha(0.92),
      backgroundPadding: new Cesium.Cartesian2(8, 4),
      pixelOffset: new Cesium.Cartesian2(14, 0),
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      show: false,
    };
    this.hoverLabel = this.labels.add(labelOptions);
    this.selectedLabel = this.labels.add(labelOptions);

    this.removePreUpdate = scene.preUpdate.addEventListener(() => this.frame());

    const canvas = scene.canvas;
    canvas.addEventListener('pointerdown', this.onInteract);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('wheel', this.onInteract, { passive: true });
    canvas.addEventListener('touchstart', this.onInteract, { passive: true });

    this.handler = new Cesium.ScreenSpaceEventHandler(canvas);
    this.handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      this.callbacks.onPick(this.pickIndex(e.position));
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    this.handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      const now = performance.now();
      if (now - this.lastHoverPick < 80) return;
      this.lastHoverPick = now;
      this.hovered = this.pickIndex(e.endPosition);
      canvas.style.cursor = this.hovered !== null ? 'pointer' : '';
      this.hoverLabel.show = this.hovered !== null && this.hovered !== this.selected;
      if (this.hovered !== null) this.hoverLabel.text = this.objects[this.hovered].name;
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    // Until the first state arrives (when the view turns to GPM), look at the Atlantic.
    this.viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(-30, 18, this.openingRangeM() - EARTH_RADIUS_M) });

    // 8192 px only where the extra detail can show: high-density screens wider than a phone.
    const sharp = container.clientWidth >= 768 && (window.devicePixelRatio || 1) > 1;
    void this.addEarth(sharp ? 8192 : 4096);
  }

  /**
   * Camera distance from Earth's centre that makes Earth span EARTH_FILL of the shorter side. Cesium's
   * fov is the horizontal angle in landscape and the vertical one in portrait, so the half-angle across
   * the shorter side is derived from it and the aspect ratio.
   */
  private openingRangeM(): number {
    const canvas = this.viewer.scene.canvas;
    const w = Math.max(canvas.clientWidth, 1);
    const h = Math.max(canvas.clientHeight, 1);
    const fov = (this.viewer.camera.frustum as Cesium.PerspectiveFrustum).fov ?? Cesium.Math.toRadians(60);
    const shortHalf = Math.atan((Math.tan(fov / 2) * Math.min(w, h)) / Math.max(w, h));
    return EARTH_RADIUS_M / Math.sin(Math.atan(EARTH_FILL * Math.tan(shortHalf)));
  }

  /** Turn the opening view over GPM, unless the person has already moved the camera. */
  private viewOverModel(): void {
    const i = this.modelIndex;
    const s = this.state;
    if (i === null || !s || this.lastInteraction > -Infinity || !Number.isFinite(s[i * STRIDE])) return;
    const [x, y, z] = temeToFixed(s[i * STRIDE], s[i * STRIDE + 1], s[i * STRIDE + 2], gmst(this.stateUnix));
    const lon = Math.atan2(y, x);
    const lat = Cesium.Math.clamp(Math.atan2(z, Math.hypot(x, y)), -Cesium.Math.toRadians(MAX_OPENING_LAT_DEG), Cesium.Math.toRadians(MAX_OPENING_LAT_DEG));
    this.viewer.camera.setView({ destination: Cesium.Cartesian3.fromRadians(lon, lat, this.openingRangeM() - EARTH_RADIUS_M) });
  }

  private async addEarth(width: number): Promise<void> {
    try {
      const url = await buildEarthTexture(width, this.palette);
      if (this.destroyed) {
        URL.revokeObjectURL(url);
        return;
      }
      this.earthTextureUrl = url;
      const provider = await Cesium.SingleTileImageryProvider.fromUrl(url);
      if (!this.destroyed) this.viewer.imageryLayers.addImageryProvider(provider);
    } catch (err) {
      // The plain ocean-coloured globe still works without coastlines.
      console.warn('Earth texture unavailable', err);
    }
  }

  private pickIndex(position: Cesium.Cartesian2): number | null {
    const picked = this.viewer.scene.pick(position, 9, 9);
    if (!picked || typeof picked.id !== 'number') return null;
    return picked.collection === this.points || picked.collection === this.pulse ? picked.id : null;
  }

  // ------------------------------------------------------------------ data

  setCatalog(objects: CatalogObject[]): void {
    this.objects = objects;
    this.points.removeAll();
    this.paths.removeAll();
    this.state = null;
    this.selected = null;
    this.introStart = null;
    const model = objects.findIndex((o) => o.norad_id === MODEL_NORAD_ID);
    this.modelIndex = model >= 0 ? model : null;
    for (const p of [this.pulseHalo, ...this.pulseRings]) {
      p.id = this.modelIndex;
      p.show = false;
    }
    this.dots = objects.map((_, i) =>
      this.points.add({
        id: i,
        position: new Cesium.Cartesian3(),
        pixelSize: this.baseSize(i),
        color: this.baseColor(i).withAlpha(this.baseAlpha(i)),
        // The model spacecraft keeps its size at every zoom so it stays easy to find.
        scaleByDistance: i === this.modelIndex ? undefined : new Cesium.NearFarScalar(2e6, 1.6, 8e7, 0.8),
        show: false,
      }),
    );
  }

  setState(buffer: Float32Array, unix: number): void {
    const first = this.state === null;
    this.state = buffer;
    this.stateUnix = unix;
    if (first) this.viewOverModel();
    if (first && !this.reducedMotion) this.startIntro();
  }

  setMask(mask: Uint8Array): void {
    this.mask = mask;
  }

  setSelected(index: number | null): void {
    this.selected = index;
    // The model spacecraft's own pulse marks it; the white ring would sit on top of it.
    this.ring.show = index !== null && index !== this.modelIndex;
    this.selectedLabel.show = index !== null;
    if (index !== null) this.selectedLabel.text = this.objects[index].name;
    this.hoverLabel.show = false;
    if (this.introStart === null) this.applyColors();
  }

  setPaths(paths: { index: number; points: Float32Array }[]): void {
    this.paths.removeAll();
    for (const { index, points } of paths) {
      const o = this.objects[index];
      if (!o || points.length < 6) continue;
      const isSelected = index === this.selected;
      const positions: Cesium.Cartesian3[] = [];
      for (let k = 0; k < points.length; k += 3) positions.push(new Cesium.Cartesian3(points[k] * 1000, points[k + 1] * 1000, points[k + 2] * 1000));
      this.paths.add({
        positions,
        width: isSelected ? 2 : 1,
        material: Cesium.Material.fromType('Color', { color: this.baseColor(index).withAlpha(isSelected ? 0.95 : 0.3) }),
      });
    }
  }

  /**
   * Fly to an object, looking from partway along its orbit normal so the orbit reads as an ellipse
   * rather than edge-on. Keeps the current distance unless that is too close to see the orbit.
   */
  focus(index: number): void {
    const s = this.state;
    if (!s || !Number.isFinite(s[index * STRIDE])) return;
    const o = index * STRIDE;
    const r = new Cesium.Cartesian3(s[o], s[o + 1], s[o + 2]);
    const h = Cesium.Cartesian3.cross(r, new Cesium.Cartesian3(s[o + 3], s[o + 4], s[o + 5]), new Cesium.Cartesian3());
    const radiusM = Cesium.Cartesian3.magnitude(r) * 1000;
    const dir = Cesium.Cartesian3.add(
      Cesium.Cartesian3.normalize(r, r),
      Cesium.Cartesian3.multiplyByScalar(Cesium.Cartesian3.normalize(h, h), 0.9, h),
      new Cesium.Cartesian3(),
    );
    Cesium.Cartesian3.normalize(dir, dir);
    Cesium.Matrix4.multiplyByPointAsVector(this.rotation, dir, dir);
    const range = Math.max(Cesium.Cartesian3.magnitude(this.viewer.camera.positionWC), radiusM * 2.2 + 8e6);
    this.viewer.camera.flyTo({ destination: Cesium.Cartesian3.multiplyByScalar(dir, range, dir), duration: this.reducedMotion ? 0 : 1.4 });
    this.onInteract();
  }

  // ------------------------------------------------------------------ per frame

  private temePosition(index: number, dt: number, result: Cesium.Cartesian3): Cesium.Cartesian3 | null {
    const s = this.state;
    if (!s) return null;
    const o = index * STRIDE;
    const x = s[o];
    if (!Number.isFinite(x)) return null;
    result.x = (x + s[o + 3] * dt) * 1000;
    result.y = (s[o + 1] + s[o + 4] * dt) * 1000;
    result.z = (s[o + 2] + s[o + 5] * dt) * 1000;
    return result;
  }

  private frame(): void {
    const nowMs = Date.now();
    const now = nowMs / 1000;
    Cesium.Matrix3.fromRotationZ(-gmst(now), this.scratchM3);
    Cesium.Matrix4.fromRotation(this.scratchM3, this.rotation);
    Cesium.Matrix4.clone(this.rotation, this.points.modelMatrix);
    Cesium.Matrix4.clone(this.rotation, this.pulse.modelMatrix);
    Cesium.Matrix4.clone(this.rotation, this.paths.modelMatrix);
    Cesium.Matrix4.clone(this.rotation, this.markers.modelMatrix);
    Cesium.Matrix4.clone(this.rotation, this.labels.modelMatrix);

    const t = performance.now() / 1000;
    const frameDt = Math.min(t - this.lastFrame, 0.25);
    this.lastFrame = t;
    if (!this.reducedMotion && this.selected === null && t - this.lastInteraction > IDLE_BEFORE_ROTATE_S) {
      this.viewer.camera.rotate(Cesium.Cartesian3.UNIT_Z, -ROTATE_RAD_S * frameDt);
    }

    if (!this.state) return;
    const dt = now - this.stateUnix;
    const pos = this.scratchPos;
    for (let i = 0; i < this.dots.length; i++) {
      const b = this.dots[i];
      const visible = this.mask[i] === 1 && this.temePosition(i, dt, pos) !== null;
      if (b.show !== visible) b.show = visible;
      if (visible) b.position = pos;
    }
    if (this.introStart !== null) this.stepIntro(t - this.introStart);
    this.stepPulse(t, dt);
    for (const [label, index] of [[this.hoverLabel, this.hovered], [this.selectedLabel, this.selected]] as const) {
      if (index !== null && label.show && this.temePosition(index, dt, pos)) label.position = pos;
    }
    if (this.selected !== null && this.temePosition(this.selected, dt, pos)) this.ring.position = pos;
  }

  // ------------------------------------------------------------------ colour

  private baseColor(i: number): Cesium.Color {
    return i === this.modelIndex ? this.model : this.colors[this.objects[i].type];
  }

  private baseAlpha(i: number): number {
    return i === this.modelIndex ? 1 : ALPHA[this.objects[i].type];
  }

  private baseSize(i: number): number {
    return i === this.modelIndex ? MODEL_SIZE : SIZE[this.objects[i].type];
  }

  /** The model spacecraft's halo and ripples (held still under reduced motion). */
  private stepPulse(t: number, dt: number): void {
    const i = this.modelIndex;
    const visible = i !== null && this.dots[i].show && this.introStart === null && this.temePosition(i, dt, this.scratchPos) !== null;
    const parts = [this.pulseHalo, ...this.pulseRings];
    for (const p of parts) if (p.show !== visible) p.show = visible;
    if (!visible) return;
    for (const p of parts) p.position = this.scratchPos;
    const dim = this.selected !== null && i !== this.selected ? DIMMED_ALPHA : 1;
    this.pulseHalo.color = Cesium.Color.clone(this.model, this.scratchColor).withAlpha(0.28 * dim, this.scratchColor);
    this.pulseRings.forEach((ring, k) => {
      const phase = this.reducedMotion ? 0.35 + k * 0.3 : ((t / PULSE_PERIOD_S + k / this.pulseRings.length) % 1);
      ring.pixelSize = PULSE_START_PX + phase * (PULSE_END_PX - PULSE_START_PX);
      const a = (1 - phase) * dim;
      // Fresh colours: the getters return the primitive's own objects, and assigning those back is a no-op.
      ring.outlineColor = this.model.withAlpha(0.9 * a);
      ring.color = this.model.withAlpha(0.18 * a);
    });
  }

  /** Shells light up from the Earth outward; the GEO belt closes into a ring by longitude. */
  private startIntro(): void {
    const s = this.state!;
    this.introDelay = new Float32Array(this.objects.length);
    for (let i = 0; i < this.objects.length; i++) {
      const cls = this.objects[i].orbit_class;
      let d = INTRO_DELAY_S[cls];
      if (cls === 'GEO') d += ((Math.atan2(s[i * STRIDE + 1], s[i * STRIDE]) + Math.PI) / (2 * Math.PI)) * INTRO_GEO_SWEEP_S;
      this.introDelay[i] = d;
    }
    this.introStart = performance.now() / 1000;
    this.stepIntro(0);
  }

  private stepIntro(elapsed: number): void {
    const done = elapsed > INTRO_DELAY_S.GEO + INTRO_GEO_SWEEP_S + INTRO_FADE_S;
    if (done) {
      this.introStart = null;
      this.applyColors();
      return;
    }
    for (let i = 0; i < this.dots.length; i++) {
      const a = Math.min(Math.max((elapsed - this.introDelay[i]) / INTRO_FADE_S, 0), 1);
      const c = Cesium.Color.clone(this.baseColor(i), this.scratchColor);
      c.alpha = a * this.baseAlpha(i);
      this.dots[i].color = c;
    }
  }

  /** With an object selected, everything else steps back so it reads clearly. */
  private applyColors(): void {
    const dim = this.selected !== null;
    for (let i = 0; i < this.dots.length; i++) {
      const b = this.dots[i];
      const c = Cesium.Color.clone(this.baseColor(i), this.scratchColor);
      const isSelected = i === this.selected;
      c.alpha = dim && !isSelected ? DIMMED_ALPHA * this.baseAlpha(i) : this.baseAlpha(i);
      b.color = c;
      b.pixelSize = isSelected ? SELECTED_SIZE : this.baseSize(i);
    }
  }

  destroy(): void {
    const canvas = this.viewer.scene.canvas;
    canvas.removeEventListener('pointerdown', this.onInteract);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('wheel', this.onInteract);
    canvas.removeEventListener('touchstart', this.onInteract);
    this.removePreUpdate();
    this.handler.destroy();
    this.viewer.destroy();
    this.destroyed = true;
    if (this.earthTextureUrl) URL.revokeObjectURL(this.earthTextureUrl);
  }
}
