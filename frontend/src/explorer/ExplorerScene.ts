import * as Cesium from 'cesium';
import type { CatalogObject, CatalogObjectType, OrbitClass } from '../types/api';
import { EARTH_COLORS, buildEarthTexture } from './earthTexture';
import { TYPE_COLOR } from './filters';
import { STRIDE, gmst } from './propagation';

// Catalog globe. Every object is a point primitive positioned in TEME (metres); the point, polyline,
// marker and label collections share one model matrix, a rotation about Z by -GMST(now), so the whole
// population turns into the Earth-fixed frame with a single matrix per frame. Positions are
// extrapolated linearly from the worker's last 1 Hz state.

export interface ExplorerSceneCallbacks {
  onPick: (index: number | null) => void;
}

const COLORS: Record<CatalogObjectType, Cesium.Color> = {
  PAYLOAD: Cesium.Color.fromCssColorString(TYPE_COLOR.PAYLOAD),
  DEBRIS: Cesium.Color.fromCssColorString(TYPE_COLOR.DEBRIS),
  ROCKET_BODY: Cesium.Color.fromCssColorString(TYPE_COLOR.ROCKET_BODY),
};
// Solid, anti-aliased dots (pixels). Debris is the most numerous, so it is the smallest and slightly
// translucent, which keeps dense shells from merging into a smear.
const SIZE: Record<CatalogObjectType, number> = { PAYLOAD: 4, DEBRIS: 3, ROCKET_BODY: 3.5 };
const ALPHA: Record<CatalogObjectType, number> = { PAYLOAD: 1, DEBRIS: 0.85, ROCKET_BODY: 0.95 };
const SELECTED_SIZE = 8;
const DIMMED_ALPHA = 0.3;
const ROTATE_RAD_S = 0.05; // about one turn every two minutes
const IDLE_BEFORE_ROTATE_S = 10;
const INTRO_DELAY_S: Record<OrbitClass, number> = { LEO: 0, MEO: 0.35, HEO: 0.5, GEO: 0.7 };
const INTRO_GEO_SWEEP_S = 0.6;
const INTRO_FADE_S = 0.5;

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
  private readonly points: Cesium.PointPrimitiveCollection;
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
    scene.globe.baseColor = Cesium.Color.fromCssColorString(EARTH_COLORS.ocean);
    scene.postProcessStages.fxaa.enabled = false;
    scene.backgroundColor = Cesium.Color.fromCssColorString('#03060c');
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.fog.enabled = false;
    scene.highDynamicRange = false;
    scene.screenSpaceCameraController.minimumZoomDistance = 300_000;
    scene.screenSpaceCameraController.maximumZoomDistance = 150_000_000;

    this.points = scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.paths = scene.primitives.add(new Cesium.PolylineCollection());
    this.markers = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
    this.labels = scene.primitives.add(new Cesium.LabelCollection({ scene }));
    this.ring = this.markers.add({ position: new Cesium.Cartesian3(), image: ringSprite(), width: 30, height: 30, show: false, disableDepthTestDistance: Number.POSITIVE_INFINITY });
    const labelOptions = {
      position: new Cesium.Cartesian3(),
      font: '13px B612, sans-serif',
      fillColor: Cesium.Color.fromCssColorString('#e2eaf5'),
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('#0a1220').withAlpha(0.8),
      backgroundPadding: new Cesium.Cartesian2(7, 4),
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

    // Far enough out that the GEO belt arcs across the frame around the Earth. In portrait the
    // field of view is vertical, so start closer to keep the globe a similar width.
    const aspect = container.clientWidth / Math.max(container.clientHeight, 1);
    const altitude = 42_000_000 * Math.min(1, Math.max(0.75, aspect * 1.3));
    this.viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(-30, 18, altitude) });

    void this.addEarth(container.clientWidth < 768 ? 4096 : 8192);
  }

  private async addEarth(width: number): Promise<void> {
    try {
      const url = await buildEarthTexture(width);
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
    return picked && picked.collection === this.points && typeof picked.id === 'number' ? picked.id : null;
  }

  // ------------------------------------------------------------------ data

  setCatalog(objects: CatalogObject[]): void {
    this.objects = objects;
    this.points.removeAll();
    this.paths.removeAll();
    this.state = null;
    this.selected = null;
    this.introStart = null;
    this.dots = objects.map((o, i) =>
      this.points.add({
        id: i,
        position: new Cesium.Cartesian3(),
        pixelSize: SIZE[o.type],
        color: COLORS[o.type].withAlpha(ALPHA[o.type]),
        scaleByDistance: new Cesium.NearFarScalar(2e6, 1.6, 8e7, 0.8),
        show: false,
      }),
    );
  }

  setState(buffer: Float32Array, unix: number): void {
    const first = this.state === null;
    this.state = buffer;
    this.stateUnix = unix;
    if (first && !this.reducedMotion) this.startIntro();
  }

  setMask(mask: Uint8Array): void {
    this.mask = mask;
  }

  setSelected(index: number | null): void {
    this.selected = index;
    this.ring.show = index !== null;
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
        material: Cesium.Material.fromType('Color', { color: COLORS[o.type].withAlpha(isSelected ? 0.95 : 0.3) }),
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
    for (const [label, index] of [[this.hoverLabel, this.hovered], [this.selectedLabel, this.selected]] as const) {
      if (index !== null && label.show && this.temePosition(index, dt, pos)) label.position = pos;
    }
    if (this.selected !== null && this.temePosition(this.selected, dt, pos)) this.ring.position = pos;
  }

  // ------------------------------------------------------------------ colour

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
      const type = this.objects[i].type;
      const c = Cesium.Color.clone(COLORS[type], this.scratchColor);
      c.alpha = a * ALPHA[type];
      this.dots[i].color = c;
    }
  }

  /** With an object selected, everything else steps back so it reads clearly. */
  private applyColors(): void {
    const dim = this.selected !== null;
    for (let i = 0; i < this.dots.length; i++) {
      const b = this.dots[i];
      const type = this.objects[i].type;
      const c = Cesium.Color.clone(COLORS[type], this.scratchColor);
      const isSelected = i === this.selected;
      c.alpha = dim && !isSelected ? DIMMED_ALPHA * ALPHA[type] : ALPHA[type];
      b.color = c;
      b.pixelSize = isSelected ? SELECTED_SIZE : SIZE[type];
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
