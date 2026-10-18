import * as Cesium from 'cesium';
import { SampledTrajectory, type Vec3 } from '../simulation/trajectory';
import { buildEarthTexture } from '../explorer/earthTexture';
import { readPalette } from '../explorer/palette';
import type { SimulationController } from '../simulation/controller';
import type { Conjunction, Maneuver, ObjectSummary, ScenarioDetail, ScreenResponse, ThreatState, Trajectory } from '../types/api';
import { TimeBridge, temeToFixed, temeToFixedMatrix, temeVelocityToFixed } from './frames';
import { SpacecraftModel } from './spacecraft';
import { addDetectionRadius, detectionRadii } from './detectionRadius';
import { GHOST_HOLD_S, formatMiss, ghostPhase, type Ghost } from '../simulation/ghosts';
import { CatalogCloud } from '../perception/catalogCloud';
import { INITIAL_PLUME, advancePlume, plumeIntensity, type BurnRef, type PlumeState } from './thrusters';

export interface LayerFlags {
  original: boolean;
  secondary: boolean;
  candidates: boolean;
  background: boolean;
  backgroundOrbits: boolean;
  markers: boolean;
  detection: boolean;
  labels: boolean;
}

export interface SceneCallbacks {
  onPick: (kind: 'object' | 'candidate' | null, id: string | null) => void;
  /** A committed burn started (`{ maneuverId }`) or stopped (`null`) firing. */
  onBurnFiring?: (info: { maneuverId: string } | null) => void;
}

export interface SceneOptions {
  /** A small picture-in-picture view: fewer pixels and frames, a coarser Earth, no camera input. */
  inset?: boolean;
}

/** A ghost of the spacecraft on the globe: the entities, the model and this frame's state. */
interface GhostActor {
  view: Ghost;
  traj: SampledTrajectory;
  entity: Cesium.Entity;
  extras: Cesium.Entity[];
  model: SpacecraftModel | null;
  /** The ghost's TEME state this frame, null while it is not flying. */
  stateNow: { p: Vec3; v: Vec3 } | null;
}

/** Per-frame facts about a piece of junk in the close-up, read by its threat cues. */
interface JunkCue {
  camDistM: number;
  gapM: number;
  threat: boolean;
}

// Path colours: a glowing teal band for the path the spacecraft will fly, dashed cyan for the original
// kept for comparison after an approved burn, green candidates.
const COLORS = {
  primary: Cesium.Color.fromCssColorString('#67e8f9'),
  planned: Cesium.Color.fromCssColorString('#2dd4bf'),
  tracked: Cesium.Color.fromCssColorString('#93c5fd'),
  monitoring: Cesium.Color.fromCssColorString('#60a5fa'),
  debris: Cesium.Color.fromCssColorString('#cbd5e1'),
  threat: Cesium.Color.fromCssColorString('#f87171'),
  warn: Cesium.Color.fromCssColorString('#fbbf24'),
  candidate: Cesium.Color.fromCssColorString('#4ade80'),
  approved: Cesium.Color.fromCssColorString('#22c55e'),
  burn: Cesium.Color.fromCssColorString('#a3e635'),
  label: Cesium.Color.fromCssColorString('#d7e1f2'),
};

/**
 * World: the camera hangs still in the inertial (TEME) frame, far enough to see the whole Earth, which
 * turns beneath the spacecraft's orbit as the clock runs; drag looks around the Earth. Follow: the
 * camera tracks the primary from a few envelope radii, so its true-scale model is in view.
 */
export type CameraMode = 'world' | 'follow';
const WORLD_RANGE_M = 21_000_000; // from the Earth's centre: the globe spans about half of the view
const WORLD_MIN_ZOOM_M = 7_000_000; // zooming toward the centre stops above the surface
// Follow's zoom floor lets the camera reach the model itself.
const MIN_ZOOM_M = 2;
// Tracking offset (metres, entity-local frame) for a primary whose model is not available yet.
const FALLBACK_VIEW_FROM = new Cesium.Cartesian3(-60, 35, 25);
const POINT_OUTLINE = Cesium.Color.fromCssColorString('#05080f');
// Paths look half an orbit ahead: a full orbit closes into a loop whose near and far sides read as two
// lines on screen. The past trail is a short tail for the same reason.
const AHEAD_ORBITS = 0.5;
const TRAIL_ORBITS = 1 / 12;
// Close views (the camera within this distance of the primary) draw the bright band only for the next
// NEAR_BAND_S of flight and the rest of the path as a thin line: from a few hundred metres away the
// orbit ahead runs into its vanishing point, where a wide band reads as a sharp corner.
const CLOSE_VIEW_M = 20_000;
const NEAR_BAND_S = 60;
// Path polylines are resampled to this many vertices per orbit (0.5° of arc) so chords never show.
const PATH_VERTICES_PER_ORBIT = 720;
// Sandbox junk within this range of the spacecraft is drawn enlarged until it spans JUNK_MIN_PIXELS on
// screen (true-scale junk is a few metres across and would be invisible at a 5 km pass); the label
// states the true size, the distance and the enlargement.
const JUNK_BOOST_RANGE_M = 30_000;
const JUNK_MIN_PIXELS = 24;
const JUNK_MAX_BOOST = 400;
// A pass is over this long after its closest approach: its markers go and it stops colouring its object.
const PASS_DONE_S = 90;
// Close-up (inset) only. Junk on a collision course with what the close-up follows is drawn as a model
// from much further out and much larger than other junk, with a red halo, a kind glyph while the model
// is still too small, and a lead arrow toward the target; other junk keeps the main view's boost.
const INSET_JUNK_MIN_PIXELS = 40;
const INSET_THREAT_BOOST_RANGE_M = 100_000;
const INSET_THREAT_MIN_PIXELS = 64;
const INSET_THREAT_MAX_BOOST = 2000;
/** An enlarged piece never grows past this fraction of its distance to the target, so it cannot swallow it. */
const JUNK_MAX_GAP_FRACTION = 0.25;
const THREAT_HALO_SCALE = 1.8;
const THREAT_HALO_MIN_PIXELS = 28;
const THREAT_LEAD_PIXELS = 40;
const THREAT_LEAD_MAX_RANGE_M = 50_000;
/**
 * Close-up: while collision-course junk is within this gap of what the close-up follows, the camera eases
 * to a spot behind and above the target looking toward the junk (keeping the user's zoom), so the
 * debris crosses the frame instead of passing behind the camera.
 */
const DIRECTOR_RANGE_M = 80_000;
const DIRECTOR_SMOOTH = 0.15;
/**
 * How far the director camera sits off the target-to-debris line (fraction of the view range), below it in
 * the radial sense: looking slightly up at the target puts the incoming debris in the lower part of the
 * frame, against space and clear of the caption (about 17 degrees off the view axis).
 */
const DIRECTOR_LIFT = -0.3;
/** The ghost's impact flash: pixel size at the collision, shrinking to the end size over GHOST_HOLD_S. */
const GHOST_FLASH_PX = 144;
const GHOST_FLASH_END_PX = 32;
const DV_ARROW_LINGER_MS = 4000;
const THREAT_ORDER: ThreatState[] = ['NORMAL', 'MONITORING', 'UNVERIFIED', 'ELEVATED', 'CRITICAL', 'MITIGATED'];

/** A unit vector in TEME for a direction given in the RTN frame of state (p, v). */
function rtnDirectionTeme(p: Vec3, v: Vec3, rtn: number[]): Vec3 {
  const norm = (a: Vec3): Vec3 => {
    const n = Math.hypot(a[0], a[1], a[2]);
    return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
  };
  const R = norm(p);
  const N = norm([p[1] * v[2] - p[2] * v[1], p[2] * v[0] - p[0] * v[2], p[0] * v[1] - p[1] * v[0]]);
  const T: Vec3 = [N[1] * R[2] - N[2] * R[1], N[2] * R[0] - N[0] * R[2], N[0] * R[1] - N[1] * R[0]];
  const d: Vec3 = [
    R[0] * rtn[0] + T[0] * rtn[1] + N[0] * rtn[2],
    R[1] * rtn[0] + T[1] * rtn[1] + N[1] * rtn[2],
    R[2] * rtn[0] + T[2] * rtn[1] + N[2] * rtn[2],
  ];
  return norm(d);
}

const SATELLITE_SVG = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
    <g fill="none" stroke="#67e8f9" stroke-width="2">
      <rect x="15" y="15" width="10" height="10" fill="#0b1220"/>
      <rect x="2" y="17" width="10" height="6" fill="#0b1220"/>
      <rect x="28" y="17" width="10" height="6" fill="#0b1220"/>
      <line x1="12" y1="20" x2="15" y2="20"/><line x1="25" y1="20" x2="28" y2="20"/>
      <circle cx="20" cy="9" r="3" fill="#0b1220"/><line x1="20" y1="12" x2="20" y2="15"/>
    </g></svg>`,
);

// Close-up glyphs for junk on a collision course while its model is still too small to see.
const JUNK_GLYPHS: Record<string, string> = {
  'debris-fragment': `<polygon points="6,20 14,4 24,10 34,6 30,20 36,30 22,36 10,32" fill="#fecaca" stroke="#f87171" stroke-width="2"/>`,
  'rocket-body': `<rect x="8" y="14" width="22" height="12" rx="4" fill="#fecaca" stroke="#f87171" stroke-width="2"/><polygon points="30,14 38,10 38,30 30,26" fill="#f87171"/>`,
  'box-wing-bus': `<rect x="15" y="14" width="10" height="12" fill="#fecaca" stroke="#f87171" stroke-width="2"/><rect x="2" y="17" width="11" height="6" fill="#fca5a5"/><rect x="27" y="17" width="11" height="6" fill="#fca5a5"/>`,
};
function junkGlyph(designId: string): string {
  const body = JUNK_GLYPHS[designId] ?? JUNK_GLYPHS['debris-fragment'];
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">${body}</svg>`)}`;
}

function objectColor(o: ObjectSummary): Cesium.Color {
  if (o.category === 'DEBRIS') return COLORS.debris;
  return COLORS.tracked;
}

/** A soft radial glow drawn as a billboard: the burn flare (lime) at the burn point, the ghost's impact flash (red). */
function flareImage(core = '247, 254, 231', glow = '163, 230, 53'): HTMLCanvasElement {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, `rgba(${core}, 1)`);
    g.addColorStop(0.25, `rgba(${glow}, 0.9)`);
    g.addColorStop(0.6, `rgba(${glow}, 0.25)`);
    g.addColorStop(1, `rgba(${glow}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return canvas;
}

export class GlobeScene {
  readonly viewer: Cesium.Viewer;
  private readonly controller: SimulationController;
  private readonly callbacks: SceneCallbacks;
  private bridge = new TimeBridge(0);
  private detail: ScenarioDetail | null = null;
  /** The store's trajectory records, to notice when one is replaced (rolling data, committed burns). */
  private records = new Map<string, Trajectory>();
  private trajectories = new Map<string, SampledTrajectory>();
  private objects = new Map<string, ObjectSummary>();
  private objectEntities = new Map<string, Cesium.Entity>();
  private objectPaths = new Map<string, Cesium.Entity[]>();
  private primaryId: string | null = null;
  private primaryEntity: Cesium.Entity | null = null;
  private periodS = 5600;
  /** The primary's TEME state as of the last frame (labels and markers read it; a frame of lag is fine). */
  private primaryStateNow: { p: Vec3; v: Vec3 } | null = null;
  private conjunction: Conjunction | null = null;
  private conjunctionEntities: Cesium.Entity[] = [];
  private candidateEntities = new Map<string, Cesium.Entity[]>();
  private candidateTrajectories = new Map<string, SampledTrajectory>();
  private candidates: Maneuver[] = [];
  private committed: Maneuver[] = [];
  private committedEntities: Cesium.Entity[] = [];
  private burnRefs: BurnRef[] = [];
  /** Ghosts of the spacecraft (one per committed burn), by burn id, and the store's current list. */
  private ghosts = new Map<string, GhostActor>();
  private ghostViews: Ghost[] = [];
  /** What Follow mode tracks: the spacecraft, or a ghost by its burn id (the close-up's tabs). */
  private trackTargetId: 'primary' | string = 'primary';
  /** The tracked target's TEME state this frame (the spacecraft's unless a flying ghost is followed). */
  private focusStateNow: { p: Vec3; v: Vec3 } | null = null;
  private criticalKm = 5;
  /** Close-up: this frame's facts about each piece of junk, for its threat cues. */
  private junkCues = new Map<string, JunkCue>();
  /** Close-up: the camera is being aimed at incoming debris (see aimAtIncomingDebris). */
  private directorActive = false;
  private readonly directorOffset = new Cesium.Cartesian3();
  /** Screened passes per secondary (state, closest-approach time, miss); past passes stop colouring an object. */
  private threats: { id: string; state: ThreatState; tcaUnix: number; missKm: number }[] = [];
  private layers: LayerFlags = { original: true, secondary: true, candidates: true, background: true, backgroundOrbits: false, markers: true, detection: true, labels: true };
  private handler: Cesium.ScreenSpaceEventHandler;
  private preUpdateRemover: Cesium.Event.RemoveCallback;
  private postUpdateRemover: Cesium.Event.RemoveCallback;
  private postRenderRemover: Cesium.Event.RemoveCallback;
  /** The real ISS scenario's whole-catalog point cloud, styled by the ML funnel (main view only). */
  private readonly cloud: CatalogCloud | null;
  private cameraMode: CameraMode = 'world';
  /** Set when the world view is (re)framed: the camera offset (TEME, metres) to apply on the next frame. */
  private pendingWorldOffset: Cesium.Cartesian3 | null = null;
  private readonly worldRotation = new Cesium.Matrix3();
  private readonly worldTransform = new Cesium.Matrix4();
  private readonly worldOffset = new Cesium.Cartesian3();
  private destroyed = false;
  /** The corner close-up (see SceneOptions). */
  private readonly inset: boolean;
  /** True-scale models for the primary, highlighted objects, spawned junk and the current threat object. */
  private models = new Map<string, SpacecraftModel>();
  private conjunctionModelId: string | null = null;
  private scratchPos = new Cesium.Cartesian3();
  private scratchVel = new Cesium.Cartesian3();
  private earthTextureUrl: string | null = null;
  /** Camera within CLOSE_VIEW_M of the primary this frame (see the band styling constants). */
  private closeView = false;
  private plume: PlumeState = INITIAL_PLUME;
  private reportedBurnId: string | null = null;
  /** The burn that fired last and when it stopped (the delta-v arrow lingers a moment after the plume). */
  private lastFired: { id: string; endedMs: number } | null = null;
  private flare: HTMLCanvasElement | null = null;
  private flareRed: HTMLCanvasElement | null = null;
  private readonly focusFixed = new Cesium.Cartesian3();
  private readonly labelCache = new Map<string, string>();

  constructor(container: HTMLElement, controller: SimulationController, callbacks: SceneCallbacks, ionToken?: string, options: SceneOptions = {}) {
    this.controller = controller;
    this.callbacks = callbacks;
    this.inset = !!options.inset;
    if (ionToken) Cesium.Ion.defaultAccessToken = ionToken;
    // The globe looks like the home page's: the same vector-drawn Earth (dark ocean, slate land, thin
    // coastlines, faint graticule), evenly lit, no atmosphere or star field, so the objects carry the
    // picture. A Cesium ion token opts into world imagery instead of the drawn Earth.
    const palette = readPalette();
    const baseLayer = ionToken ? Cesium.ImageryLayer.fromWorldImagery({}) : false;
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
      shouldAnimate: false,
      baseLayer,
      skyBox: false,
      skyAtmosphere: false,
      requestRenderMode: false,
      targetFrameRate: 60,
      // as on the home page: the display's real pixel ratio, MSAA instead of the softening FXAA pass
      useBrowserRecommendedResolution: false,
      msaaSamples: 4,
    });
    const scene = this.viewer.scene;
    scene.globe.enableLighting = false;
    scene.globe.showGroundAtmosphere = false;
    scene.globe.baseColor = Cesium.Color.fromCssColorString(palette.ocean);
    scene.backgroundColor = Cesium.Color.fromCssColorString(palette.bg);
    scene.postProcessStages.fxaa.enabled = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.highDynamicRange = false;
    scene.screenSpaceCameraController.minimumZoomDistance = MIN_ZOOM_M;
    scene.screenSpaceCameraController.maximumZoomDistance = 80_000_000;
    scene.fog.enabled = false;
    if (options.inset) {
      this.viewer.resolutionScale = 0.75;
      this.viewer.targetFrameRate = 30;
      // the close-up orbits the spacecraft (drag) and zooms (wheel, pinch, the +/- buttons) but never leaves it
      const input = scene.screenSpaceCameraController;
      input.enableRotate = true;
      input.enableTilt = true;
      input.enableZoom = true;
      input.enableTranslate = false;
      input.enableLook = false;
    }
    this.viewer.clock.shouldAnimate = false;
    this.viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;

    // Cesium evaluates entity positions during clock.tick(), before preUpdate. The simulation
    // controller therefore sets the clock for the *next* frame in postRender, and everything
    // rendered in a frame (entities, polylines, the spacecraft primitives, the tracked camera)
    // uses the same clock time.
    this.viewer.clock.currentTime = this.bridge.toJulian(this.controller.currentUnix, this.viewer.clock.currentTime);
    this.preUpdateRemover = scene.preUpdate.addEventListener(() => this.onPreUpdate());
    // World view: re-anchor the camera to the inertial frame every frame, so it stays put while the
    // Earth-fixed globe turns; the camera's own position (in that frame) carries the user's rotation and zoom.
    this.postUpdateRemover = scene.postUpdate.addEventListener(() => {
      if (this.destroyed || this.cameraMode !== 'world') return;
      const rotation = temeToFixedMatrix(this.viewer.clock.currentTime, this.worldRotation);
      const offset = this.pendingWorldOffset ?? Cesium.Cartesian3.clone(this.viewer.camera.position, this.worldOffset);
      this.pendingWorldOffset = null;
      Cesium.Matrix4.fromRotationTranslation(rotation, Cesium.Cartesian3.ZERO, this.worldTransform);
      this.viewer.camera.lookAtTransform(this.worldTransform, offset);
    });
    this.postRenderRemover = scene.postRender.addEventListener(() => {
      this.viewer.clock.currentTime = this.bridge.toJulian(this.controller.currentUnix, this.viewer.clock.currentTime);
    });
    this.cloud = this.inset ? null : new CatalogCloud(this.viewer, controller);

    this.handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
    this.handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = scene.pick(movement.position);
      const entity = picked && picked.id instanceof Cesium.Entity ? picked.id : null;
      const id = entity?.id ?? null;
      if (!id) {
        this.callbacks.onPick(null, null);
        return;
      }
      if (id.startsWith('obj:')) this.callbacks.onPick('object', id.slice(4));
      else if (id.startsWith('cand:')) this.callbacks.onPick('candidate', id.slice(5).split('#')[0]);
      else if (id.startsWith('tca:')) this.callbacks.onPick('object', id.slice(4));
      else this.callbacks.onPick(null, null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(20, 15, 22_000_000),
    });

    if (!ionToken) {
      // 8192 px only where the extra detail can show: high-density screens wider than a phone.
      const sharp = Math.max(container.clientWidth, window.innerWidth) >= 768 && (window.devicePixelRatio || 1) > 1;
      void this.addEarth(options.inset ? 2048 : sharp ? 8192 : 4096, palette);
    }
  }

  /** The home page's drawn Earth as the globe's imagery (the plain ocean-coloured globe stands in until it is ready). */
  private async addEarth(width: number, colors: { ocean: string; land: string; coast: string }): Promise<void> {
    try {
      const url = await buildEarthTexture(width, colors);
      if (this.destroyed) {
        URL.revokeObjectURL(url);
        return;
      }
      this.earthTextureUrl = url;
      const provider = await Cesium.SingleTileImageryProvider.fromUrl(url);
      if (!this.destroyed) this.viewer.imageryLayers.addImageryProvider(provider);
    } catch (err) {
      console.warn('Earth texture unavailable; keeping the plain globe', err);
    }
  }

  // ------------------------------------------------------------------ per frame
  private onPreUpdate(): void {
    const time = this.viewer.clock.currentTime;
    const unix = this.bridge.toUnix(time);
    const camera = this.viewer.camera.positionWC;
    const primaryTraj = this.primaryId ? this.trajectories.get(this.primaryId) : undefined;
    const primaryState = primaryTraj?.stateAt(unix) ?? null;
    this.primaryStateNow = primaryState;
    // ghosts first: the camera may be following one
    for (const actor of this.ghosts.values()) {
      const phase = ghostPhase(actor.view, unix);
      actor.stateNow = phase === 'alive' || phase === 'crashing' ? actor.traj.stateAt(unix) : null;
    }
    this.syncTrackedEntity();
    const trackedGhost = this.trackTargetId !== 'primary' ? this.ghosts.get(this.trackTargetId) : undefined;
    this.focusStateNow = trackedGhost?.stateNow ?? primaryState;
    const focusFixed = this.focusStateNow ? temeToFixed(time, this.focusStateNow.p, this.focusFixed) : null;
    this.closeView = !!focusFixed && Cesium.Cartesian3.distance(camera, focusFixed) < CLOSE_VIEW_M;
    for (const [id, model] of this.models) {
      const st = this.trajectories.get(id)?.stateAt(unix);
      if (!st) {
        model.hide();
        this.junkCues.delete(id);
        continue;
      }
      const pos = temeToFixed(time, st.p, this.scratchPos);
      let scale = 1;
      const obj = this.objects.get(id);
      if (obj?.spawned_at_unix != null && id !== this.primaryId && focusFixed) {
        // Spawned junk near what the view follows is drawn enlarged so it can be seen at all. In the
        // close-up, junk on a collision course with the followed target is drawn from much further out.
        const gap = Cesium.Cartesian3.distance(pos, focusFixed);
        const camDist = Cesium.Cartesian3.distance(camera, pos);
        const threat = this.inset && this.onCollisionCourse(id, unix);
        if (gap < (threat ? INSET_THREAT_BOOST_RANGE_M : JUNK_BOOST_RANGE_M)) {
          const minPixels = threat ? INSET_THREAT_MIN_PIXELS : this.inset ? INSET_JUNK_MIN_PIXELS : JUNK_MIN_PIXELS;
          scale = model.boostFor(camDist, minPixels, threat ? INSET_THREAT_MAX_BOOST : JUNK_MAX_BOOST);
          if (this.inset) scale = Math.max(1, Math.min(scale, (JUNK_MAX_GAP_FRACTION * gap) / model.envelopeRadiusM));
        }
        if (this.inset) this.junkCues.set(id, { camDistM: camDist, gapM: gap, threat });
      }
      model.update(pos, temeVelocityToFixed(time, st.v, pos, this.scratchVel), scale);
    }
    for (const actor of this.ghosts.values()) {
      if (!actor.model) continue;
      const st = actor.stateNow;
      if (!st || ghostPhase(actor.view, unix) !== 'alive') {
        actor.model.hide();
        continue;
      }
      const pos = temeToFixed(time, st.p, this.scratchPos);
      actor.model.update(pos, temeVelocityToFixed(time, st.v, pos, this.scratchVel), 1);
    }
    if (this.inset) this.aimAtIncomingDebris(unix);
    // the primary's thrusters: a plume while a committed burn fires, a faint glow just before
    const realNow = performance.now();
    this.plume = advancePlume(this.plume, { nowUnix: unix, speed: this.controller.speed, playing: this.controller.playing, realNowMs: realNow, burns: this.burnRefs });
    const primaryModel = this.primaryId ? this.models.get(this.primaryId) : undefined;
    // a little flicker makes the plume read as exhaust rather than a lit cone
    const flicker = 0.82 + 0.18 * (0.5 + 0.5 * Math.sin(realNow * 0.045));
    primaryModel?.setPlume(this.plume.active?.face ?? this.plume.preGlow?.face ?? null, plumeIntensity(this.plume, realNow) * flicker);
    const firing = this.plume.active?.id ?? null;
    if (firing !== this.reportedBurnId) {
      if (this.reportedBurnId) this.lastFired = { id: this.reportedBurnId, endedMs: realNow };
      this.reportedBurnId = firing;
      if (!this.inset) this.callbacks.onBurnFiring?.(firing ? { maneuverId: firing } : null);
    }
  }

  // ------------------------------------------------------------------ helpers
  private unixOf(time: Cesium.JulianDate | undefined): number {
    return time ? this.bridge.toUnix(time) : this.controller.currentUnix;
  }

  private positionProperty(objectId: string): Cesium.CallbackPositionProperty {
    return new Cesium.CallbackPositionProperty((time, result) => {
      const p = this.trajectories.get(objectId)?.positionAt(this.unixOf(time));
      // a NaN position would stop Cesium's render loop for good; no position is a skipped frame
      if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) return undefined;
      return temeToFixed(time ?? this.bridge.toJulian(this.controller.currentUnix), p, result);
    }, false, Cesium.ReferenceFrame.FIXED);
  }

  private staticPositionProperty(p: [number, number, number]): Cesium.CallbackPositionProperty {
    return new Cesium.CallbackPositionProperty((time, result) => {
      return temeToFixed(time ?? this.bridge.toJulian(this.controller.currentUnix), p, result);
    }, false, Cesium.ReferenceFrame.FIXED);
  }

  /** Polyline positions for a time span of a trajectory (looked up at evaluation), re-rotated into the fixed frame each frame. */
  private pathPositions(
    source: () => SampledTrajectory | undefined | null,
    span: (now: number) => [number, number] | null,
  ): Cesium.CallbackProperty {
    return new Cesium.CallbackProperty((time) => {
      const traj = source();
      if (!traj) return [];
      const now = this.unixOf(time);
      const s = span(now);
      if (!s) return [];
      const jd = time ?? this.bridge.toJulian(now);
      const pts = traj.pointsBetween(s[0], s[1], { stepS: this.pathStepS(), maxPoints: 1200 });
      if (pts.length < 2) return [];
      return pts.map((pt) => temeToFixed(jd, pt.p));
    }, false);
  }

  private trajectoryOf(objectId: string): () => SampledTrajectory | undefined {
    return () => this.trajectories.get(objectId);
  }

  /** Resampling step for path polylines: half a degree of orbit per vertex, between 2 s and 60 s. */
  private pathStepS(): number {
    return Math.min(60, Math.max(2, this.periodS / PATH_VERTICES_PER_ORBIT));
  }

  /** The bright part of a band: the whole span, or only the next NEAR_BAND_S in a close view. */
  private nearSpan(now: number, start: number, end: number): [number, number] | null {
    const e = this.closeView ? Math.min(end, Math.max(start, now + NEAR_BAND_S)) : end;
    return start < e ? [start, e] : null;
  }

  /** The thin continuation of a band in a close view (nothing in far views). */
  private farSpan(now: number, start: number, end: number): [number, number] | null {
    if (!this.closeView) return null;
    const s = Math.max(start, now + NEAR_BAND_S);
    return s < end ? [s, end] : null;
  }

  private dash(color: Cesium.Color | Cesium.Property, gap = 12): Cesium.PolylineDashMaterialProperty {
    return new Cesium.PolylineDashMaterialProperty({ color, dashLength: gap, gapColor: Cesium.Color.TRANSPARENT });
  }

  /** The path-band look: a bright core with a soft glow across a wide polyline. */
  private glow(color: Cesium.Color): Cesium.PolylineGlowMaterialProperty {
    return new Cesium.PolylineGlowMaterialProperty({ color, glowPower: 0.22, taperPower: 1 });
  }

  private labelGraphics(text: string, color: Cesium.Color, offsetY = -14): Cesium.LabelGraphics.ConstructorOptions {
    return {
      text,
      font: '11px "JetBrains Mono", Menlo, monospace',
      fillColor: color,
      style: Cesium.LabelStyle.FILL,
      pixelOffset: new Cesium.Cartesian2(0, offsetY),
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('#0b1220').withAlpha(0.7),
      backgroundPadding: new Cesium.Cartesian2(5, 3),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      show: new Cesium.CallbackProperty(() => this.layers.labels, false),
      scaleByDistance: new Cesium.NearFarScalar(1e5, 1.0, 2e7, 0.7),
    };
  }

  /** An object's colour: the worst state of its passes still ahead (or just behind), its category otherwise. */
  private colorFor(objectId: string, base: Cesium.Color): Cesium.Color {
    const now = this.controller.currentUnix;
    let rank = -1;
    for (const t of this.threats) {
      if (t.id !== objectId || t.tcaUnix < now - PASS_DONE_S) continue;
      const r = THREAT_ORDER.indexOf(t.state);
      if (r > rank) rank = r;
    }
    const state = rank >= 0 ? THREAT_ORDER[rank] : null;
    if (state === 'CRITICAL' || state === 'ELEVATED') return COLORS.threat;
    if (state === 'UNVERIFIED') return COLORS.warn;
    if (state === 'MONITORING') return COLORS.monitoring;
    return base;
  }

  /** Spawned junk labels say what the eye cannot: true size, distance to the spacecraft, enlargement. */
  private junkLabel(obj: ObjectSummary): string {
    const id = obj.object_id;
    const sizeM = Math.max(obj.design.length_m, obj.design.width_m, obj.design.height_m);
    const st = this.trajectories.get(id)?.stateAt(this.controller.currentUnix);
    const p = this.primaryStateNow;
    const distKm = st && p ? Math.hypot(st.p[0] - p.p[0], st.p[1] - p.p[1], st.p[2] - p.p[2]) : null;
    const boost = this.models.get(id)?.displayScale ?? 1;
    const key = `${distKm === null ? '-' : distKm < 100 ? distKm.toFixed(1) : Math.round(distKm)}|${boost > 1.05 ? Math.round(boost) : 1}`;
    const cached = this.labelCache.get(id);
    if (cached && cached.startsWith(key + '\u0000')) return cached.slice(key.length + 1);
    const text = `${obj.name} · ${sizeM.toFixed(1)} m` + (distKm === null ? '' : ` · ${distKm < 100 ? `${distKm.toFixed(1)} km` : `${Math.round(distKm)} km`} away`) + (boost > 1.05 ? ` · drawn ×${Math.round(boost)}` : '');
    this.labelCache.set(id, key + '\u0000' + text);
    return text;
  }

  // ------------------------------------------------------------------ scenario
  /** Start a scenario: clears everything; objects arrive through updateTrajectories. */
  setScenario(detail: ScenarioDetail): void {
    this.clearScenario();
    this.detail = detail;
    this.bridge = new TimeBridge(detail.window.start_unix);
    this.viewer.clock.currentTime = this.bridge.toJulian(this.controller.currentUnix, this.viewer.clock.currentTime);
    this.primaryId = detail.primary_id;
    this.criticalKm = detectionRadii(detail.thresholds).criticalKm;
  }

  /**
   * Bring the drawn objects in line with the store: new ids get entities (and models where they
   * matter), replaced records take effect on the next frame, missing ids disappear.
   */
  updateTrajectories(records: Record<string, Trajectory>, objects: Record<string, ObjectSummary>): void {
    if (!this.detail) return;
    for (const [id, o] of Object.entries(objects)) this.objects.set(id, o);
    const primary = this.primaryId ? this.objects.get(this.primaryId) : undefined;
    this.periodS = primary?.period_s ?? 5600;
    for (const id of [...this.records.keys()]) if (!(id in records)) this.removeObject(id);
    let primaryAdded = false;
    for (const [id, t] of Object.entries(records)) {
      const obj = this.objects.get(id);
      if (!obj) continue;
      const prev = this.records.get(id);
      if (prev === t) continue;
      this.records.set(id, t);
      this.trajectories.set(id, new SampledTrajectory(t));
      if (!prev) {
        this.addObject(obj);
        if (id === this.primaryId) primaryAdded = true;
      }
    }
    if (primaryAdded) this.applyCameraMode();
    this.reconcileGhosts();
  }

  private addObject(obj: ObjectSummary): void {
    const detail = this.detail!;
    const id = obj.object_id;
    const isPrimary = id === this.primaryId;
    const isHighlight = detail.highlight_object_ids.includes(id);
    const spawnedAt = obj.spawned_at_unix ?? null;
    const baseColor = isPrimary ? COLORS.primary : isHighlight ? COLORS.threat : objectColor(obj);
    const color = isPrimary ? baseColor : new Cesium.CallbackProperty(() => this.colorFor(id, baseColor), false);
    const pos = this.positionProperty(id);
    // spawned junk exists from its spawn time on (its trajectory starts there too)
    const present = () => spawnedAt === null || this.controller.currentUnix >= spawnedAt;
    const entity = this.viewer.entities.add({
      id: `obj:${id}`,
      name: obj.name,
      position: pos,
      // The primary's point never hides: Cesium moves a tracked camera only while the tracked entity
      // has something to bound, and with labels off the point is all it has. Once the model takes
      // over, the point turns transparent instead.
      point: {
        pixelSize: isPrimary ? 9 : isHighlight || spawnedAt !== null ? 7 : 5,
        color: isPrimary ? new Cesium.CallbackProperty(() => (this.modelShown(id) ? Cesium.Color.TRANSPARENT : baseColor), false) : color,
        outlineColor: isPrimary
          ? new Cesium.CallbackProperty(() => (this.modelShown(id) ? Cesium.Color.TRANSPARENT : POINT_OUTLINE), false)
          : POINT_OUTLINE,
        outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        show: new Cesium.CallbackProperty(() => isPrimary || (present() && (isHighlight || spawnedAt !== null || this.layers.background) && !this.modelShown(id)), false),
      },
      label: this.labelGraphics(obj.name, baseColor, isPrimary ? -22 : -12),
    });
    if (spawnedAt !== null) {
      // junk gathers around the spacecraft's path; from the World view its labels would pile up there
      entity.label!.text = new Cesium.CallbackProperty(() => this.junkLabel(obj), false);
      entity.label!.fillColor = new Cesium.CallbackProperty(() => this.colorFor(id, COLORS.label), false);
      entity.label!.distanceDisplayCondition = new Cesium.ConstantProperty(new Cesium.DistanceDisplayCondition(0, 3.0e6));
      entity.label!.show = new Cesium.CallbackProperty(() => this.layers.labels && present(), false);
    } else if (!isPrimary && !isHighlight) {
      // background labels only when close enough to matter
      entity.label!.distanceDisplayCondition = new Cesium.ConstantProperty(new Cesium.DistanceDisplayCondition(0, 3.5e6));
      entity.label!.show = new Cesium.CallbackProperty(() => this.layers.labels && this.layers.background, false);
    }
    this.objectEntities.set(id, entity);

    if (isPrimary || isHighlight || spawnedAt !== null) this.addModel(obj);
    if (isPrimary) {
      entity.viewFrom = this.defaultViewFrom();
      this.primaryEntity = entity;
      this.addPrimaryIcon(pos);
      addDetectionRadius(this.viewer.entities, { primary: entity, thresholds: detail.thresholds, objects: () => this.objectEntities.values(), show: () => this.layers.detection, showLabels: () => this.layers.labels, bubbleRadiusM: this.inset ? 1.5 * (this.models.get(id)?.envelopeRadiusM ?? 8) : undefined });
      this.addPrimaryPath();
    } else {
      this.addObjectPath(id, baseColor, isHighlight, spawnedAt);
      if (spawnedAt !== null && this.inset) this.addThreatCues(obj, pos, present);
    }
  }

  private removeObject(id: string): void {
    const entity = this.objectEntities.get(id);
    if (entity) this.viewer.entities.remove(entity);
    for (const e of this.objectPaths.get(id) ?? []) this.viewer.entities.remove(e);
    this.objectEntities.delete(id);
    this.objectPaths.delete(id);
    if (id !== this.primaryId) this.removeModel(id);
    if (this.conjunctionModelId === id) this.conjunctionModelId = null;
    this.records.delete(id);
    this.trajectories.delete(id);
    this.labelCache.delete(id);
    this.junkCues.delete(id);
  }

  private addModel(obj: ObjectSummary): void {
    if (this.models.has(obj.object_id) || !obj.design) return;
    this.models.set(obj.object_id, new SpacecraftModel(this.viewer.scene, obj.design, { rcs: obj.object_id === this.primaryId }));
  }

  private removeModel(objectId: string): void {
    this.models.get(objectId)?.destroy();
    this.models.delete(objectId);
  }

  private modelShown(objectId: string): boolean {
    return this.models.get(objectId)?.shown ?? false;
  }

  /**
   * Default tracking offset (Cesium frames it as along-velocity, orbit-normal, radial): a few envelope
   * radii behind and above the primary, in its orbit plane, so the model fills a good part of the frame
   * and the path ahead projects to one straight line through it rather than a corner at the horizon.
   */
  private defaultViewFrom(): Cesium.Cartesian3 {
    const r = this.primaryId ? this.models.get(this.primaryId)?.envelopeRadiusM : undefined;
    if (!r) return FALLBACK_VIEW_FROM;
    return new Cesium.Cartesian3(-4 * r, 0, 1.6 * r);
  }

  private addPrimaryIcon(pos: Cesium.PositionProperty): void {
    // Far away: a billboard icon. Once it is big enough on screen: the true-scale model (see SpacecraftModel).
    const icon = this.viewer.entities.add({
      id: 'primary-icon',
      position: pos,
      billboard: {
        image: `data:image/svg+xml;charset=utf-8,${SATELLITE_SVG}`,
        width: 28,
        height: 28,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        show: new Cesium.CallbackProperty(() => !(this.primaryId && this.modelShown(this.primaryId)), false),
      },
    });
    this.objectPaths.set('primary-icon', [icon]);
  }

  private addPrimaryPath(): void {
    const id = this.primaryId!;
    const source = this.trajectoryOf(id);
    const ahead = () => this.periodS * AHEAD_ORBITS;
    const tail = () => this.periodS * TRAIL_ORBITS;
    const showOriginal = new Cesium.CallbackProperty(() => this.layers.original, false);
    // Past trail (solid, dim): a short tail behind the current time.
    const trail = this.viewer.entities.add({
      id: 'path:primary:past',
      polyline: {
        positions: this.pathPositions(source, (now) => [now - tail(), now]),
        width: 1.5,
        material: COLORS.planned.withAlpha(0.3),
        arcType: Cesium.ArcType.NONE,
        show: showOriginal,
      },
    });
    // Planned path (the teal band): half an orbit ahead along the trajectory the spacecraft will fly,
    // committed burns included (the band bends at each burn).
    const planned = this.viewer.entities.add({
      id: 'path:primary:planned',
      polyline: {
        positions: this.pathPositions(source, (now) => this.nearSpan(now, now, now + ahead())),
        width: 9,
        material: this.glow(COLORS.planned.withAlpha(0.95)),
        arcType: Cesium.ArcType.NONE,
        show: showOriginal,
      },
    });
    // In close views the band beyond the next minute continues as a thin line (see CLOSE_VIEW_M).
    const plannedFar = this.viewer.entities.add({
      id: 'path:primary:planned-far',
      polyline: {
        positions: this.pathPositions(source, (now) => this.farSpan(now, now, now + ahead())),
        width: 2,
        material: COLORS.planned.withAlpha(0.45),
        arcType: Cesium.ArcType.NONE,
        show: showOriginal,
      },
    });
    // (The course before a committed burn is drawn by that burn's ghost, see addGhost.)
    this.objectPaths.set(id, [trail, planned, plannedFar]);
  }

  private addObjectPath(objectId: string, baseColor: Cesium.Color, isHighlight: boolean, spawnedAt: number | null): void {
    const period = () => this.objects.get(objectId)?.period_s ?? this.periodS;
    const spawned = spawnedAt !== null;
    const color = new Cesium.CallbackProperty(() => this.colorFor(objectId, baseColor).withAlpha(isHighlight ? 0.85 : spawned ? 0.6 : 0.4), false);
    const entity = this.viewer.entities.add({
      id: `path:${objectId}`,
      polyline: {
        positions: this.pathPositions(this.trajectoryOf(objectId), (now) => {
          const start = Math.max(now - period() * 0.5, spawnedAt ?? Number.NEGATIVE_INFINITY);
          return start < now + period() ? [start, now + period()] : null;
        }),
        width: isHighlight ? 2 : spawned ? 1.5 : 1,
        material: this.dash(color, isHighlight || spawned ? 12 : 8),
        arcType: Cesium.ArcType.NONE,
        show: new Cesium.CallbackProperty(() => {
          if (isHighlight || spawned) return this.layers.secondary && (spawnedAt === null || this.controller.currentUnix >= spawnedAt);
          return this.layers.backgroundOrbits && this.layers.background;
        }, false),
      },
    });
    this.objectPaths.set(objectId, [entity]);
  }

  // ------------------------------------------------------------------ conjunction
  setConjunction(conj: Conjunction | null): void {
    for (const e of this.conjunctionEntities) this.viewer.entities.remove(e);
    this.conjunctionEntities = [];
    this.conjunction = conj;
    if (this.conjunctionModelId) this.removeModel(this.conjunctionModelId);
    this.conjunctionModelId = null;
    if (!conj) return;
    const secondary = this.objects.get(conj.secondary_id);
    if (secondary && this.trajectories.has(conj.secondary_id) && !this.models.has(conj.secondary_id)) {
      this.addModel(secondary);
      this.conjunctionModelId = conj.secondary_id;
    }
    const rp = conj.primary_state_teme.r_km as [number, number, number];
    const rs = conj.secondary_state_teme.r_km as [number, number, number];
    const mid: [number, number, number] = [(rp[0] + rs[0]) / 2, (rp[1] + rs[1]) / 2, (rp[2] + rs[2]) / 2];
    // the markers describe a pass ahead; once it is over they go, whatever is selected
    const show = new Cesium.CallbackProperty(() => this.layers.markers && this.controller.currentUnix < conj.tca_unix + PASS_DONE_S, false);
    // Danger region: enlarged sphere at the predicted closest-approach point.
    const radiusM = Math.max(2500, Math.min(25_000, conj.miss_distance_km * 1000 * 3));
    this.conjunctionEntities.push(
      this.viewer.entities.add({
        id: 'tca:region',
        position: this.staticPositionProperty(mid),
        ellipsoid: {
          radii: new Cesium.Cartesian3(radiusM, radiusM, radiusM),
          material: COLORS.threat.withAlpha(0.18),
          outline: true,
          outlineColor: COLORS.threat.withAlpha(0.6),
          slicePartitions: 24,
          stackPartitions: 16,
          show,
        },
        label: {
          ...this.labelGraphics(`PREDICTED TCA · miss ${conj.miss_distance_km < 1 ? `${(conj.miss_distance_km * 1000).toFixed(0)} m` : `${conj.miss_distance_km.toFixed(2)} km`}`, COLORS.threat, -18),
          show,
        },
      }),
      // Ghost markers where each object is predicted to be at TCA.
      this.viewer.entities.add({
        id: `tca:${conj.primary_id}`,
        position: this.staticPositionProperty(rp),
        point: { pixelSize: 7, color: Cesium.Color.TRANSPARENT, outlineColor: COLORS.primary, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY, show },
      }),
      this.viewer.entities.add({
        id: `tca:${conj.secondary_id}`,
        position: this.staticPositionProperty(rs),
        point: { pixelSize: 7, color: Cesium.Color.TRANSPARENT, outlineColor: COLORS.threat, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY, show },
      }),
      // Miss vector between the two predicted positions.
      this.viewer.entities.add({
        id: 'tca:missvector',
        polyline: {
          positions: new Cesium.CallbackProperty((time) => {
            const jd = time ?? this.bridge.toJulian(this.controller.currentUnix);
            return [temeToFixed(jd, rp), temeToFixed(jd, rs)];
          }, false),
          width: 2,
          material: COLORS.threat,
          arcType: Cesium.ArcType.NONE,
          show,
        },
      }),
    );
  }

  /** Colour objects by their screened threat state (red critical/elevated, amber unverified, blue monitoring). */
  setThreats(screening: ScreenResponse | null): void {
    this.threats = (screening?.conjunctions ?? []).map((c) => ({ id: c.secondary_id, state: c.threat_state, tcaUnix: c.tca_unix, missKm: c.miss_distance_km }));
  }

  // ------------------------------------------------------------------ candidates
  /** Candidate burns under consideration; committed ones are drawn by setCommittedBurns instead. */
  setCandidates(candidates: Maneuver[], trajectories: Record<string, Trajectory>, selectedId: string | null, committedIds: string[]): void {
    for (const list of this.candidateEntities.values()) for (const e of list) this.viewer.entities.remove(e);
    this.candidateEntities.clear();
    this.candidateTrajectories.clear();
    this.candidates = candidates;
    for (const cand of candidates) {
      if (committedIds.includes(cand.maneuver_id)) continue;
      const t = trajectories[cand.maneuver_id];
      if (!t) continue;
      const traj = new SampledTrajectory(t);
      this.candidateTrajectories.set(cand.maneuver_id, traj);
      const isSelected = selectedId === cand.maneuver_id;
      const color = COLORS.candidate;
      const burn = cand.burn_time_unix;
      const showPath = new Cesium.CallbackProperty(() => this.layers.candidates, false);
      // from the burn through the closest approach, for comparison with the current path
      const span = (now: number): [number, number] => [Math.max(burn, now - this.periodS), Math.max(cand.post_tca_unix + 900, now + this.periodS * AHEAD_ORBITS)];
      const entities: Cesium.Entity[] = [];
      if (isSelected) {
        // close views: the band beyond the next minute continues as a thin line (see CLOSE_VIEW_M)
        entities.push(
          this.viewer.entities.add({
            id: `cand:${cand.maneuver_id}#path-far`,
            polyline: {
              positions: this.pathPositions(() => traj, (now) => this.farSpan(now, ...span(now))),
              width: 2,
              material: color.withAlpha(0.45),
              arcType: Cesium.ArcType.NONE,
              show: showPath,
            },
          }),
        );
      }
      entities.push(
        this.viewer.entities.add({
          id: `cand:${cand.maneuver_id}#path`,
          polyline: {
            positions: this.pathPositions(() => traj, (now) => {
              const [start, end] = span(now);
              return isSelected ? this.nearSpan(now, start, end) : start < end ? [start, end] : null;
            }),
            // selected: a green band; other candidates: faint solid green
            width: isSelected ? 7 : 1.5,
            material: isSelected ? this.glow(color.withAlpha(0.85)) : color.withAlpha(0.4),
            arcType: Cesium.ArcType.NONE,
            show: showPath,
          },
        }),
        this.viewer.entities.add({
          id: `cand:${cand.maneuver_id}#burn`,
          position: this.staticPositionProperty(cand.burn_state_teme.r_km as [number, number, number]),
          point: {
            pixelSize: isSelected ? 9 : 6,
            color: COLORS.burn,
            outlineColor: POINT_OUTLINE,
            outlineWidth: 1.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            show: showPath,
          },
          label: {
            ...this.labelGraphics(`BURN ${cand.direction} ${cand.dv_magnitude_mps.toFixed(2)} m/s`, COLORS.burn, 22),
            show: new Cesium.CallbackProperty(() => this.layers.labels && isSelected, false),
          },
        }),
      );
      if (isSelected) {
        // the maneuvered primary as a moving ghost marker after the burn
        entities.push(
          this.viewer.entities.add({
            id: `cand:${cand.maneuver_id}#ghost`,
            position: new Cesium.CallbackPositionProperty((time, result) => {
              const p = traj.positionAt(this.unixOf(time));
              return p ? temeToFixed(time ?? this.bridge.toJulian(this.controller.currentUnix), p, result) : undefined;
            }, false, Cesium.ReferenceFrame.FIXED),
            point: {
              pixelSize: 6,
              color: color.withAlpha(0.9),
              outlineColor: POINT_OUTLINE,
              outlineWidth: 1,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              show: new Cesium.CallbackProperty(() => this.layers.candidates && this.controller.currentUnix >= burn, false),
            },
            label: {
              ...this.labelGraphics('MANEUVERED (CANDIDATE)', color, 24),
              show: new Cesium.CallbackProperty(() => this.layers.labels && this.layers.candidates && this.controller.currentUnix >= burn, false),
            },
          }),
          this.viewer.entities.add({
            id: `cand:${cand.maneuver_id}#tca`,
            position: this.staticPositionProperty(cand.post_primary_state_teme.r_km as [number, number, number]),
            point: { pixelSize: 7, color: Cesium.Color.TRANSPARENT, outlineColor: color, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY, show: showPath },
            label: { ...this.labelGraphics(`POST-BURN TCA · miss ${cand.post_miss_distance_km.toFixed(2)} km`, color, 22), show: new Cesium.CallbackProperty(() => this.layers.labels && this.layers.markers, false) },
          }),
        );
      }
      this.candidateEntities.set(cand.maneuver_id, entities);
    }
  }

  // ------------------------------------------------------------------ committed burns
  /**
   * Burns that are part of the primary's trajectory: a marker and label at each burn point, the
   * post-burn closest approach, a flare while the burn fires, and the thruster plume on the model.
   * The course before each burn is a ghost's (setGhosts).
   */
  setCommittedBurns(maneuvers: Maneuver[]): void {
    for (const e of this.committedEntities) this.viewer.entities.remove(e);
    this.committedEntities = [];
    this.committed = maneuvers;
    this.burnRefs = maneuvers.map((m) => ({ id: m.maneuver_id, burnUnix: m.burn_time_unix, dvRtn: m.dv_rtn_mps }));
    for (const m of maneuvers) {
      const mid = m.maneuver_id;
      const burn = m.burn_time_unix;
      const showMarker = new Cesium.CallbackProperty(() => this.layers.markers && this.controller.currentUnix < burn + this.periodS, false);
      const intensity = () => (this.plume.active?.id === mid ? plumeIntensity(this.plume, performance.now()) : 0);
      const hhmmss = new Date(burn * 1000).toISOString().slice(11, 19);
      // the delta-v itself, drawn from the spacecraft while the burn fires and a moment after
      const arrowOn = () => this.plume.active?.id === mid || (this.lastFired?.id === mid && performance.now() - this.lastFired.endedMs < DV_ARROW_LINGER_MS);
      const dvRtn = m.dv_rtn_mps;
      this.committedEntities.push(
        this.viewer.entities.add({
          id: `burn:${mid}#dv`,
          polyline: {
            positions: new Cesium.CallbackProperty((time) => {
              const st = this.primaryStateNow;
              if (!st || !arrowOn()) return [];
              const r = this.primaryId ? this.models.get(this.primaryId)?.envelopeRadiusM ?? 10 : 10;
              const dir = rtnDirectionTeme(st.p, st.v, dvRtn);
              const lengthKm = Math.max(3 * r, 30) / 1000;
              const tip: Vec3 = [st.p[0] + dir[0] * lengthKm, st.p[1] + dir[1] * lengthKm, st.p[2] + dir[2] * lengthKm];
              const jd = time ?? this.bridge.toJulian(this.controller.currentUnix);
              return [temeToFixed(jd, st.p), temeToFixed(jd, tip)];
            }, false),
            width: 14,
            material: new Cesium.PolylineArrowMaterialProperty(COLORS.burn),
            arcType: Cesium.ArcType.NONE,
            show: new Cesium.CallbackProperty(() => arrowOn(), false),
          },
        }),
        this.viewer.entities.add({
          id: `burn:${mid}#point`,
          position: this.staticPositionProperty(m.burn_state_teme.r_km as [number, number, number]),
          point: { pixelSize: 9, color: COLORS.burn, outlineColor: POINT_OUTLINE, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY, show: showMarker },
          label: {
            ...this.labelGraphics(`BURN ${m.direction} ${m.dv_magnitude_mps.toFixed(2)} m/s · ${hhmmss}`, COLORS.burn, 22),
            show: new Cesium.CallbackProperty(() => this.layers.labels && this.layers.markers && this.controller.currentUnix < burn + this.periodS, false),
          },
        }),
        this.viewer.entities.add({
          id: `burn:${mid}#tca`,
          position: this.staticPositionProperty(m.post_primary_state_teme.r_km as [number, number, number]),
          point: { pixelSize: 7, color: Cesium.Color.TRANSPARENT, outlineColor: COLORS.approved, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY, show: new Cesium.CallbackProperty(() => this.layers.markers && this.controller.currentUnix < m.post_tca_unix + 900, false) },
          label: {
            ...this.labelGraphics(`POST-BURN TCA · miss ${m.post_miss_distance_km.toFixed(2)} km`, COLORS.approved, 22),
            show: new Cesium.CallbackProperty(() => this.layers.labels && this.layers.markers && this.controller.currentUnix < m.post_tca_unix + 900, false),
          },
        }),
        this.viewer.entities.add({
          id: `burn:${mid}#flare`,
          position: this.staticPositionProperty(m.burn_state_teme.r_km as [number, number, number]),
          billboard: {
            image: (this.flare ??= flareImage()),
            width: new Cesium.CallbackProperty(() => 48 + 64 * intensity(), false),
            height: new Cesium.CallbackProperty(() => 48 + 64 * intensity(), false),
            color: new Cesium.CallbackProperty(() => Cesium.Color.WHITE.withAlpha(Math.min(1, 0.3 + intensity())), false),
            show: new Cesium.CallbackProperty(() => this.plume.active?.id === mid, false),
          },
        }),
      );
    }
  }

  // ------------------------------------------------------------------ ghosts
  /**
   * Ghosts of the spacecraft: one per committed burn, flying the course it would have flown without
   * that burn until the pass the burn avoided. Diffed by burn id (the store replaces its simulation
   * state often); a ghost whose path is still loading is skipped until it arrives.
   */
  setGhosts(ghosts: Ghost[]): void {
    this.ghostViews = ghosts;
    this.reconcileGhosts();
  }

  private reconcileGhosts(): void {
    if (this.destroyed || !this.detail) return;
    const wanted = new Map(this.ghostViews.filter((g) => g.trajectory).map((g) => [g.id, g]));
    for (const id of [...this.ghosts.keys()]) if (!wanted.has(id)) this.removeGhost(id);
    const design = this.primaryId ? this.objects.get(this.primaryId)?.design : undefined;
    for (const [id, view] of wanted) {
      let actor = this.ghosts.get(id);
      if (!actor) {
        actor = this.addGhost(view);
      } else if (actor.view !== view) {
        if (actor.view.trajectory !== view.trajectory && view.trajectory) actor.traj = new SampledTrajectory(view.trajectory);
        actor.view = view;
      }
      if (design && !actor.model) actor.model = new SpacecraftModel(this.viewer.scene, design, { ghost: true });
    }
    this.syncTrackedEntity();
  }

  private addGhost(view: Ghost): GhostActor {
    const id = view.id;
    const actor: GhostActor = { view, traj: new SampledTrajectory(view.trajectory!), entity: null as unknown as Cesium.Entity, extras: [], model: null, stateNow: null };
    const now = () => this.controller.currentUnix;
    const phase = () => ghostPhase(actor.view, now());
    const flying = () => {
      const p = phase();
      return p === 'alive' || p === 'crashing';
    };
    const modelShown = () => actor.model?.shown ?? false;
    const position = new Cesium.CallbackPositionProperty((time, result) => {
      const p = actor.traj.positionAt(this.unixOf(time));
      if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) return undefined;
      return temeToFixed(time ?? this.bridge.toJulian(now()), p, result);
    }, false, Cesium.ReferenceFrame.FIXED);
    const miss = formatMiss(view.missKm);
    actor.entity = this.viewer.entities.add({
      id: `ghost:${id}`,
      name: `Ghost ${view.index}`,
      position,
      viewFrom: this.defaultViewFrom(),
      // kept shown while the ghost flies (transparent once the model draws): a tracked entity needs a graphic to bound
      point: {
        pixelSize: 7,
        color: new Cesium.CallbackProperty(() => (modelShown() ? Cesium.Color.TRANSPARENT : COLORS.primary.withAlpha(0.85)), false),
        outlineColor: new Cesium.CallbackProperty(() => (modelShown() ? Cesium.Color.TRANSPARENT : POINT_OUTLINE), false),
        outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        show: new Cesium.CallbackProperty(flying, false),
      },
      label: {
        ...this.labelGraphics('', COLORS.primary, -22),
        text: new Cesium.CallbackProperty(() => {
          const dt = Math.max(0, actor.view.crashUnix - now());
          const m = Math.floor(dt / 60);
          const s = Math.floor(dt % 60);
          return `GHOST ${actor.view.index} · NO DODGE · meets ${actor.view.secondaryName} in ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} · ${miss}`;
        }, false),
        show: new Cesium.CallbackProperty(() => this.layers.labels && phase() === 'alive', false),
      },
    });
    const ahead = () => this.periodS * AHEAD_ORBITS;
    // the course not taken, dashed, from the ghost to the collision
    actor.extras.push(
      this.viewer.entities.add({
        id: `ghost:${id}#path`,
        polyline: {
          positions: this.pathPositions(() => actor.traj, (t) => {
            if (ghostPhase(actor.view, t) !== 'alive') return null;
            const start = Math.max(t, actor.view.bornUnix);
            const end = Math.min(t + ahead(), actor.view.crashUnix);
            return start < end ? [start, end] : null;
          }),
          width: 2,
          material: this.dash(COLORS.primary.withAlpha(0.7)),
          arcType: Cesium.ArcType.NONE,
          show: new Cesium.CallbackProperty(() => this.layers.original, false),
        },
      }),
    );
    const crashPoint = view.crashPointTeme ?? actor.traj.positionAt(view.crashUnix) ?? null;
    if (crashPoint) {
      actor.extras.push(
        this.viewer.entities.add({
          id: `ghost:${id}#crash`,
          position: this.staticPositionProperty(crashPoint),
          point: { pixelSize: 8, color: Cesium.Color.TRANSPARENT, outlineColor: COLORS.threat, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY, show: new Cesium.CallbackProperty(() => this.layers.markers && flying(), false) },
          label: {
            ...this.labelGraphics(`WOULD MEET ${view.secondaryName.toUpperCase()} · ${miss} · inside ${view.criticalRadiusKm} km`, COLORS.threat, 22),
            show: new Cesium.CallbackProperty(() => this.layers.labels && this.layers.markers && flying(), false),
          },
        }),
      );
    }
    // the impact flash at the collision, in both views
    const flashPx = () => {
      const f = Math.min(1, Math.max(0, 1 - (now() - actor.view.crashUnix) / GHOST_HOLD_S));
      return GHOST_FLASH_END_PX + (GHOST_FLASH_PX - GHOST_FLASH_END_PX) * f;
    };
    actor.extras.push(
      this.viewer.entities.add({
        id: `ghost:${id}#flash`,
        position,
        billboard: {
          image: (this.flareRed ??= flareImage('255, 241, 242', '248, 113, 113')),
          width: new Cesium.CallbackProperty(flashPx, false),
          height: new Cesium.CallbackProperty(flashPx, false),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: new Cesium.CallbackProperty(() => phase() === 'crashing', false),
        },
      }),
    );
    this.ghosts.set(id, actor);
    return actor;
  }

  private removeGhost(id: string): void {
    const actor = this.ghosts.get(id);
    if (!actor) return;
    // never remove what the camera tracks: Cesium would be left with nothing to follow
    if (this.trackTargetId === id) {
      this.trackTargetId = 'primary';
      this.syncTrackedEntity();
    }
    this.viewer.entities.remove(actor.entity);
    for (const e of actor.extras) this.viewer.entities.remove(e);
    actor.model?.destroy();
    this.ghosts.delete(id);
  }

  /** Follow the spacecraft ('primary') or one of its ghosts (by burn id); applied as soon as the ghost exists and flies. */
  setTrackTarget(id: 'primary' | string): void {
    if (id === this.trackTargetId) return;
    this.trackTargetId = id;
    this.syncTrackedEntity();
  }

  /** The entity Follow mode should track right now: the chosen ghost while it flies, else the spacecraft. */
  private trackedEntity(): Cesium.Entity | null {
    if (this.trackTargetId !== 'primary') {
      const actor = this.ghosts.get(this.trackTargetId);
      if (actor && actor.stateNow) return actor.entity;
    }
    return this.primaryEntity;
  }

  /** Re-track when the wanted entity changed (a ghost arrived, died, or the tab moved); a change re-applies the default offset. */
  private syncTrackedEntity(): void {
    if (this.destroyed || this.cameraMode !== 'follow') return;
    const want = this.trackedEntity();
    if (!want || this.viewer.trackedEntity === want) return;
    want.viewFrom = this.defaultViewFrom();
    this.viewer.trackedEntity = want;
  }

  /**
   * Close-up: while a piece of junk on a collision course with the followed target is within
   * DIRECTOR_RANGE_M, move the camera (smoothly) to look from behind and above the target toward the
   * debris, at the user's current range. Cesium keeps a tracked camera in the entity's velocity frame
   * (x along the velocity, y the orbit normal, z radial), so the offset is computed in that frame.
   */
  private aimAtIncomingDebris(unix: number): void {
    const focus = this.focusStateNow;
    const camera = this.viewer.camera;
    if (!focus || !this.viewer.trackedEntity || this.cameraMode !== 'follow') {
      this.directorActive = false;
      return;
    }
    let bestId: string | null = null;
    let bestGap = DIRECTOR_RANGE_M;
    for (const [id, c] of this.junkCues) {
      if (c.threat && c.gapM < bestGap) {
        bestGap = c.gapM;
        bestId = id;
      }
    }
    const junk = bestId ? this.trajectories.get(bestId)?.stateAt(unix) : null;
    if (!junk) {
      this.directorActive = false;
      return;
    }
    const norm = (a: Vec3): Vec3 | null => {
      const n = Math.hypot(a[0], a[1], a[2]);
      return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : null;
    };
    const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const z = norm(focus.p);
    const vhat = norm(focus.v);
    const y = z && vhat ? norm(cross(z, vhat)) : null;
    const u = norm([junk.p[0] - focus.p[0], junk.p[1] - focus.p[1], junk.p[2] - focus.p[2]]);
    if (!z || !y || !u) return;
    const x = cross(y, z);
    const uLocal: Vec3 = [dot(u, x), dot(u, y), dot(u, z)];
    // offset along the target's radial axis, made perpendicular to the line toward the debris (DIRECTOR_LIFT < 0: below it)
    let lift: Vec3 = [-uLocal[0] * uLocal[2], -uLocal[1] * uLocal[2], 1 - uLocal[2] * uLocal[2]];
    lift = norm(lift) ?? [0, 1, 0];
    const range = Math.max(Cesium.Cartesian3.magnitude(camera.position), MIN_ZOOM_M * 2);
    const dir = norm([-uLocal[0] + DIRECTOR_LIFT * lift[0], -uLocal[1] + DIRECTOR_LIFT * lift[1], -uLocal[2] + DIRECTOR_LIFT * lift[2]]);
    if (!dir) return;
    const desired = Cesium.Cartesian3.fromElements(dir[0] * range, dir[1] * range, dir[2] * range, this.directorOffset);
    // the camera's position is its offset in the tracked frame: ease from where it is to where it should be
    const next = this.directorActive ? Cesium.Cartesian3.lerp(camera.position, desired, DIRECTOR_SMOOTH, desired) : Cesium.Cartesian3.lerp(camera.position, desired, DIRECTOR_SMOOTH * 2, desired);
    const n = Cesium.Cartesian3.magnitude(next);
    if (!(n > 0) || !Number.isFinite(n)) return;
    Cesium.Cartesian3.multiplyByScalar(next, range / n, next);
    camera.lookAtTransform(camera.transform, next);
    this.directorActive = true;
  }

  /** Close-up: is this piece of junk heading for what the close-up follows? */
  private onCollisionCourse(objectId: string, now: number): boolean {
    const tracked = this.trackTargetId !== 'primary' ? this.ghosts.get(this.trackTargetId) : undefined;
    if (tracked && tracked.stateNow) return tracked.view.secondaryId === objectId && now < tracked.view.crashUnix + GHOST_HOLD_S;
    for (const t of this.threats) {
      if (t.id !== objectId || t.tcaUnix < now - PASS_DONE_S) continue;
      if (t.state === 'CRITICAL' || t.state === 'ELEVATED' || t.missKm <= this.criticalKm) return true;
    }
    return false;
  }

  /** Close-up cues for a piece of junk on a collision course: a red halo, a kind glyph while the model is too small, a lead arrow. */
  private addThreatCues(obj: ObjectSummary, pos: Cesium.PositionProperty, present: () => boolean): void {
    const id = obj.object_id;
    const cue = () => this.junkCues.get(id);
    const model = () => this.models.get(id);
    const active = () => present() && (cue()?.threat ?? false);
    const haloPx = () => {
      const c = cue();
      const m = model();
      if (!c || !m) return THREAT_HALO_MIN_PIXELS;
      return Math.max(THREAT_HALO_MIN_PIXELS, THREAT_HALO_SCALE * m.pixelsAcross(c.camDistM, m.displayScale));
    };
    const entities = [
      this.viewer.entities.add({
        id: `cue:${id}#halo`,
        position: pos,
        billboard: {
          image: (this.flareRed ??= flareImage('255, 241, 242', '248, 113, 113')),
          width: new Cesium.CallbackProperty(haloPx, false),
          height: new Cesium.CallbackProperty(haloPx, false),
          color: COLORS.threat.withAlpha(0.6),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: new Cesium.CallbackProperty(active, false),
        },
      }),
      this.viewer.entities.add({
        id: `cue:${id}#glyph`,
        position: pos,
        billboard: {
          image: junkGlyph(obj.design.design_id),
          width: 22,
          height: 22,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: new Cesium.CallbackProperty(() => active() && !this.modelShown(id), false),
        },
      }),
      this.viewer.entities.add({
        id: `cue:${id}#lead`,
        polyline: {
          positions: new Cesium.CallbackProperty((time) => {
            const c = cue();
            const m = model();
            const st = this.trajectories.get(id)?.stateAt(this.unixOf(time));
            const focus = this.focusStateNow;
            if (!c || !m || !st || !focus || c.gapM <= 1 || c.gapM > THREAT_LEAD_MAX_RANGE_M) return [];
            const lengthKm = Math.min(THREAT_LEAD_PIXELS * m.metresPerPixelAt(c.camDistM), 0.8 * c.gapM) / 1000;
            const d: Vec3 = [focus.p[0] - st.p[0], focus.p[1] - st.p[1], focus.p[2] - st.p[2]];
            const n = Math.hypot(d[0], d[1], d[2]);
            if (!(n > 0) || !Number.isFinite(lengthKm)) return [];
            const tip: Vec3 = [st.p[0] + (d[0] / n) * lengthKm, st.p[1] + (d[1] / n) * lengthKm, st.p[2] + (d[2] / n) * lengthKm];
            const jd = time ?? this.bridge.toJulian(this.controller.currentUnix);
            return [temeToFixed(jd, st.p), temeToFixed(jd, tip)];
          }, false),
          width: 8,
          material: new Cesium.PolylineArrowMaterialProperty(COLORS.threat.withAlpha(0.85)),
          arcType: Cesium.ArcType.NONE,
          show: new Cesium.CallbackProperty(active, false),
        },
      }),
    ];
    this.objectPaths.get(id)?.push(...entities);
  }

  // ------------------------------------------------------------------ layers / camera
  setLayers(layers: LayerFlags): void {
    this.layers = { ...layers };
  }

  /** Zoom toward what the camera looks at by `factor` (> 1 closer): the spacecraft in Follow, the Earth in World. */
  zoomCamera(factor: number): void {
    if (this.destroyed || !(factor > 0)) return;
    const camera = this.viewer.camera;
    // in both modes the camera sits in a frame centred on its target, so its position is the range
    const range = Cesium.Cartesian3.magnitude(camera.position);
    const [lo, hi] = this.cameraMode === 'follow' && this.viewer.trackedEntity ? [MIN_ZOOM_M * 2, 5_000_000] : [WORLD_MIN_ZOOM_M, 80_000_000];
    const target = Math.min(hi, Math.max(lo, range / factor));
    camera.zoomIn(range - target);
  }

  setCameraMode(mode: CameraMode): void {
    if (this.cameraMode === mode) return;
    this.cameraMode = mode;
    this.applyCameraMode();
  }

  /** Back to the current view's default framing after the user has zoomed or orbited the camera. */
  resetCamera(): void {
    this.applyCameraMode();
  }

  private applyCameraMode(): void {
    if (this.destroyed) return;
    const controller = this.viewer.scene.screenSpaceCameraController;
    this.viewer.trackedEntity = undefined;
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    if (this.cameraMode === 'follow') {
      controller.minimumZoomDistance = MIN_ZOOM_M;
      const target = this.trackedEntity();
      if (target) {
        // re-tracking makes Cesium apply the offset again
        target.viewFrom = this.defaultViewFrom();
        this.viewer.trackedEntity = target;
      }
      return;
    }
    controller.minimumZoomDistance = WORLD_MIN_ZOOM_M;
    // without a trajectory yet, the camera keeps its place (re-read as an inertial offset on the next frame)
    this.pendingWorldOffset = this.worldFraming() ?? Cesium.Cartesian3.clone(this.viewer.camera.position);
  }

  /**
   * Default world-view camera offset (TEME, metres): above the orbit plane on the spacecraft's side,
   * so the orbit reads as a ring around the Earth with the spacecraft on the near side.
   */
  private worldFraming(): Cesium.Cartesian3 | null {
    const traj = this.primaryId ? this.trajectories.get(this.primaryId) : null;
    const st = traj?.stateAt(this.controller.currentUnix);
    if (!st) return null;
    const radial = Cesium.Cartesian3.normalize(new Cesium.Cartesian3(st.p[0], st.p[1], st.p[2]), new Cesium.Cartesian3());
    const velocity = new Cesium.Cartesian3(st.v[0], st.v[1], st.v[2]);
    const normal = Cesium.Cartesian3.cross(radial, velocity, new Cesium.Cartesian3());
    if (Cesium.Cartesian3.magnitude(normal) < 1e-9) return Cesium.Cartesian3.multiplyByScalar(radial, WORLD_RANGE_M, radial);
    Cesium.Cartesian3.normalize(normal, normal);
    const direction = Cesium.Cartesian3.add(normal, Cesium.Cartesian3.multiplyByScalar(radial, 0.8, radial), normal);
    Cesium.Cartesian3.normalize(direction, direction);
    return Cesium.Cartesian3.multiplyByScalar(direction, WORLD_RANGE_M, direction);
  }

  // ------------------------------------------------------------------ cleanup
  private clearScenario(): void {
    this.setConjunction(null);
    this.setCandidates([], {}, null, []);
    this.setCommittedBurns([]);
    for (const id of [...this.ghosts.keys()]) this.removeGhost(id);
    this.ghostViews = [];
    this.trackTargetId = 'primary';
    this.focusStateNow = null;
    this.junkCues.clear();
    this.viewer.trackedEntity = undefined;
    this.viewer.entities.removeAll();
    this.objectEntities.clear();
    this.objectPaths.clear();
    this.records.clear();
    this.trajectories.clear();
    this.objects.clear();
    this.labelCache.clear();
    this.primaryEntity = null;
    this.primaryId = null;
    this.primaryStateNow = null;
    this.detail = null;
    for (const id of [...this.models.keys()]) this.removeModel(id);
    this.conjunctionModelId = null;
    this.plume = INITIAL_PLUME;
    this.lastFired = null;
    this.threats = [];
    if (this.reportedBurnId !== null) {
      this.reportedBurnId = null;
      if (!this.inset) this.callbacks.onBurnFiring?.(null);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.preUpdateRemover();
    this.postUpdateRemover();
    this.postRenderRemover();
    this.cloud?.destroy();
    for (const id of [...this.models.keys()]) this.removeModel(id);
    for (const actor of this.ghosts.values()) actor.model?.destroy();
    this.ghosts.clear();
    this.handler.destroy();
    this.viewer.destroy();
    if (this.earthTextureUrl) URL.revokeObjectURL(this.earthTextureUrl);
  }

  get currentConjunction(): Conjunction | null {
    return this.conjunction;
  }

  get currentCandidates(): Maneuver[] {
    return this.candidates;
  }

  get committedBurns(): Maneuver[] {
    return this.committed;
  }
}
