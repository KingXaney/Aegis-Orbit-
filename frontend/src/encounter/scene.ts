import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { LayerFlags } from '../globe/scene';
import type { SimulationController } from '../simulation/controller';
import { SampledTrajectory } from '../simulation/trajectory';
import type { Maneuver, ObjectSummary, PerceptionTier, ScenarioDetail, Trajectory } from '../types/api';
import { DEFAULT_THRESHOLDS, MAP, alongUnits, inverseAlong, laneTicks, lateralUnits, objectMapPosition, timeTicks, trailMapOffsets, type EncounterThresholds } from './encounterMap';
import type { EncounterItem } from './encounters';
import { disposeObject, makeDashedLine, makeDisc, makeLine, makePoints, makeRibbon, makeRing, makeSpacecraft, roundedBox, setLinePoints, setPoints, type Ribbon } from './geometry';
import { fmtCountdown, fmtKm, makeLabel, setLabel, type LabelKind } from './labels';
import { DEFAULT_PLANE, chaseRibbonPoints, ribbonProfile, sampleProfile, type PlaneBasis } from './ribbon';
import { relativeStateRtn, rtnToWorld } from './rtn';
import { styleFor, type TierStyle } from './tiers';

export type EncounterMode = 'map' | 'chase';

export interface EncounterCallbacks {
  onPick: (objectId: string | null, conjunctionId: string | null) => void;
  onError?: (message: string) => void;
}

export const CHASE = {
  VISIBILITY_KM: 100,
  FADE_FROM_KM: 80,
  SAT_SPAN_KM: 0.35,
  RIBBON_AHEAD_S: 20,
  LOOK_AT_KM: 25, // the chase camera pivots toward a critical object inside this range
  DANGER_WINDOW_S: 120,
  MISS_LINE_KM: 10,
  GRID_DEPTH_KM: 1.5,
  SIZE_PER_KM: 0.025, // far boxes grow to 2.5 % of their distance so they stay visible
};
const RIBBON_ROWS = 96;
const SAT_Y = 0.32;
const MAX_WATCH_SLABS = 12;
const TIER_ORDER: PerceptionTier[] = ['CRITICAL', 'SEMI_CRITICAL', 'ML_WATCH', 'HIDDEN'];

interface Visual {
  item: EncounterItem;
  group: THREE.Group;
  box: THREE.Mesh;
  fill: THREE.MeshBasicMaterial;
  edges: THREE.LineSegments;
  edgeMat: THREE.LineBasicMaterial;
  outline: THREE.LineSegments | null;
  outlineMat: THREE.LineBasicMaterial | null;
  stem: THREE.Line | null;
  label: CSS2DObject;
  labelKind: LabelKind;
  trail: THREE.Points | null;
  danger: THREE.Mesh | null;
  style: TierStyle;
  slabIndex: number;
}

export class EncounterScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly labelRenderer: CSS2DRenderer;
  private readonly controls: OrbitControls;
  private readonly container: HTMLElement;
  private readonly controller: SimulationController;
  private readonly callbacks: EncounterCallbacks;
  private readonly resizeObserver: ResizeObserver;
  private raf = 0;
  private destroyed = false;
  private mode: EncounterMode = 'map';
  private mini = false;
  private frame = 0;
  private reducedMotion = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  private layers: LayerFlags = { original: true, secondary: true, candidates: true, background: true, backgroundOrbits: false, markers: true, labels: true };
  private thresholds: EncounterThresholds = DEFAULT_THRESHOLDS;
  private items: EncounterItem[] = [];
  private visuals: Visual[] = [];
  private chaseVisuals = new Map<string, Visual>();
  private trajectories = new Map<string, SampledTrajectory>();
  private objects = new Map<string, ObjectSummary>();
  private primaryName = 'primary';
  private primaryTraj: SampledTrajectory | null = null;
  private maneuver: Maneuver | null = null;
  private maneuverTraj: SampledTrajectory | null = null;
  private approved = false;
  private selectedObjectId: string | null = null;
  private selectedConjunctionId: string | null = null;
  private planeBasis: PlaneBasis = DEFAULT_PLANE;
  private profile: Float64Array | null = null;
  private lastLabelUpdate = 0;
  private pointerStart: { x: number; y: number } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pickables: THREE.Mesh[] = [];
  private readonly centers = new Float32Array(RIBBON_ROWS * 3);
  private readonly scratch = new THREE.Vector3();
  private readonly chaseTargetDefault = new THREE.Vector3(0, 0, -2.4);
  private readonly tickLabels: CSS2DObject[] = [];
  // scene content
  private readonly mapStatic = new THREE.Group();
  private readonly laneGroup = new THREE.Group();
  private readonly timeGroup = new THREE.Group();
  private readonly chaseStatic = new THREE.Group();
  private readonly dynamic = new THREE.Group();
  private readonly ribbon: Ribbon;
  private readonly candidateRibbon: Ribbon;
  private readonly ghostLine: THREE.Line;
  private readonly mapSat: THREE.Group;
  private readonly chaseSat: THREE.Group;
  private readonly mapGhostSat: THREE.Group;
  private readonly chaseGhostSat: THREE.Group;
  private readonly satLabel: CSS2DObject;
  private readonly burnMarker: THREE.Mesh;
  private readonly burnLabel: CSS2DObject;
  private readonly missLine: THREE.Line;
  private readonly missLabel: CSS2DObject;
  private readonly dangerRing: THREE.Group;
  private lastThresholdKey = '';

  constructor(container: HTMLElement, controller: SimulationController, callbacks: EncounterCallbacks) {
    this.container = container;
    this.controller = controller;
    this.callbacks = callbacks;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor('#05080f', 1);
    Object.assign(this.renderer.domElement.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
    container.appendChild(this.renderer.domElement);
    this.labelRenderer = new CSS2DRenderer();
    Object.assign(this.labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
    container.appendChild(this.labelRenderer.domElement);

    this.scene.background = new THREE.Color('#05080f');
    this.scene.fog = new THREE.Fog('#05080f', 70, 150);
    this.scene.add(new THREE.HemisphereLight('#93c5fd', '#0b1220', 0.9));
    const sun = new THREE.DirectionalLight('#ffffff', 0.7);
    sun.position.set(5, 10, 6);
    this.scene.add(sun);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 500);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    // --- static map content
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshBasicMaterial({ color: '#10244a' }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.03;
    const road = new THREE.Mesh(new THREE.PlaneGeometry(2 * MAP.EDGE_UNITS, MAP.ROAD_LENGTH_UNITS), new THREE.MeshBasicMaterial({ color: '#0b182e' }));
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, -0.015, -(MAP.ROAD_LENGTH_UNITS / 2 - 12));
    this.mapStatic.add(ground, road, this.laneGroup, this.timeGroup);
    this.scene.add(this.mapStatic);

    // --- static chase content
    const grid = new THREE.GridHelper(240, 48, '#1e2a42', '#121c30');
    grid.position.y = -CHASE.GRID_DEPTH_KM;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    this.dangerRing = new THREE.Group();
    this.dangerRing.add(makeRing(1, 0.05, '#ef4444', 0.7), makeDisc(0.5, '#ef4444', 0.18));
    this.dangerRing.visible = false;
    this.chaseStatic.add(grid, this.dangerRing);
    this.scene.add(this.chaseStatic);

    // --- paths, satellite, markers
    this.ribbon = makeRibbon(RIBBON_ROWS);
    this.candidateRibbon = makeRibbon(RIBBON_ROWS, '#4ade80', '#bbf7d0', 0.45);
    this.candidateRibbon.group.visible = false;
    this.ghostLine = makeDashedLine('#67e8f9', 0.55, 0.9, 0.6);
    this.ghostLine.visible = false;
    this.mapSat = makeSpacecraft(MAP.SAT_SPAN_UNITS);
    this.chaseSat = makeSpacecraft(CHASE.SAT_SPAN_KM);
    this.mapGhostSat = makeSpacecraft(MAP.SAT_SPAN_UNITS, true);
    this.chaseGhostSat = makeSpacecraft(CHASE.SAT_SPAN_KM, true);
    this.mapGhostSat.visible = false;
    this.chaseGhostSat.visible = false;
    this.satLabel = makeLabel('satellite', 'primary');
    this.satLabel.position.set(0, 0.8, 0);
    this.mapSat.add(this.satLabel);
    this.burnMarker = new THREE.Mesh(new THREE.OctahedronGeometry(0.35), new THREE.MeshBasicMaterial({ color: '#a3e635' }));
    this.burnMarker.visible = false;
    this.burnLabel = makeLabel('burn', 'BURN');
    this.burnLabel.position.set(0, 0.6, 0);
    this.burnMarker.add(this.burnLabel);
    this.missLine = makeLine([new THREE.Vector3(), new THREE.Vector3()], '#ef4444', 0.9);
    this.missLine.visible = false;
    this.missLabel = makeLabel('measure', '');
    this.missLabel.visible = false;
    this.scene.add(this.ribbon.group, this.candidateRibbon.group, this.ghostLine, this.mapSat, this.chaseSat, this.mapGhostSat, this.chaseGhostSat, this.burnMarker, this.missLine, this.missLabel, this.dynamic);

    this.rebuildGuides();
    this.applyMode();

    // picking (click, not drag)
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('webglcontextlost', this.onContextLost);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.raf = requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------------ public API
  setMode(mode: EncounterMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.applyMode();
  }

  setScenario(detail: ScenarioDetail, objects: ObjectSummary[], trajectories: Trajectory[]): void {
    this.objects.clear();
    for (const o of objects) this.objects.set(o.object_id, o);
    this.primaryName = this.objects.get(detail.primary_id)?.name ?? detail.primary_id;
    this.trajectories.clear();
    for (const t of trajectories) this.trajectories.set(t.object_id, new SampledTrajectory(t));
    this.primaryTraj = this.trajectories.get(detail.primary_id) ?? null;
    setLabel(this.satLabel, this.primaryName);
    this.profile = null;
    this.rebuildProfile();
  }

  setEncounters(items: EncounterItem[], thresholds: EncounterThresholds): void {
    this.items = items;
    this.thresholds = thresholds;
    const key = JSON.stringify(thresholds);
    if (key !== this.lastThresholdKey) {
      this.lastThresholdKey = key;
      this.rebuildGuides();
    }
    this.updatePlaneBasis();
    this.rebuildVisuals();
  }

  setManeuver(m: Maneuver | null, trajectory: Trajectory | null, approved: boolean): void {
    this.maneuver = m;
    this.maneuverTraj = trajectory ? new SampledTrajectory(trajectory) : null;
    this.approved = approved;
    setLabel(this.satLabel, approved && m ? `${this.primaryName} · maneuvered (approved ${m.maneuver_id})` : this.primaryName);
    this.rebuildProfile();
  }

  setSelection(objectId: string | null, conjunctionId: string | null): void {
    this.selectedObjectId = objectId;
    this.selectedConjunctionId = conjunctionId;
    this.updatePlaneBasis();
    this.rebuildProfile();
    this.rebuildVisuals();
  }

  setLayers(layers: LayerFlags): void {
    this.layers = { ...layers };
  }

  setMiniMode(mini: boolean): void {
    this.mini = mini;
    this.labelRenderer.domElement.style.display = mini ? 'none' : '';
  }

  resetCamera(): void {
    this.applyMode();
  }

  stats(): { mode: EncounterMode; objects: number; visible: number; now: number; ribbonRows: number } {
    const list = this.mode === 'map' ? this.visuals : Array.from(this.chaseVisuals.values());
    return { mode: this.mode, objects: this.items.length, visible: list.filter((v) => v.group.visible).length, now: this.controller.currentUnix, ribbonRows: RIBBON_ROWS };
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('webglcontextlost', this.onContextLost);
    this.controls.dispose();
    this.clearVisuals();
    this.scene.traverse((o) => {
      if (o instanceof CSS2DObject) o.element.remove();
    });
    disposeObject(this.scene);
    this.renderer.dispose();
    el.remove();
    this.labelRenderer.domElement.remove();
  }

  // ------------------------------------------------------------------ mode + guides
  private applyMode(): void {
    const map = this.mode === 'map';
    this.mapStatic.visible = map;
    this.chaseStatic.visible = !map;
    this.mapSat.visible = map;
    this.chaseSat.visible = !map;
    this.burnMarker.visible = false;
    this.missLine.visible = false;
    this.missLabel.visible = false;
    if (map) {
      this.camera.near = 0.5;
      this.camera.far = 500;
      this.camera.fov = 50;
      this.camera.position.set(0, 12, 16);
      this.controls.target.set(0, 0, -6.6);
      this.controls.minDistance = 8;
      this.controls.maxDistance = 60;
      this.controls.minPolarAngle = THREE.MathUtils.degToRad(20);
      this.controls.maxPolarAngle = THREE.MathUtils.degToRad(80);
      this.controls.minAzimuthAngle = THREE.MathUtils.degToRad(-60);
      this.controls.maxAzimuthAngle = THREE.MathUtils.degToRad(60);
      (this.scene.fog as THREE.Fog).near = 70;
      (this.scene.fog as THREE.Fog).far = 150;
    } else {
      this.camera.near = 0.02;
      this.camera.far = 400;
      this.camera.fov = 62;
      this.camera.position.set(0, 3.5, 7.2);
      this.controls.target.set(0, 0, -2.4);
      this.controls.minDistance = 1.5;
      this.controls.maxDistance = 40;
      this.controls.minPolarAngle = THREE.MathUtils.degToRad(10);
      this.controls.maxPolarAngle = THREE.MathUtils.degToRad(85);
      this.controls.minAzimuthAngle = -Infinity;
      this.controls.maxAzimuthAngle = Infinity;
      (this.scene.fog as THREE.Fog).near = 60;
      (this.scene.fog as THREE.Fog).far = 150;
    }
    this.camera.updateProjectionMatrix();
    this.controls.update();
    for (const v of this.visuals) v.group.visible = false;
    for (const v of this.chaseVisuals.values()) v.group.visible = false;
  }

  private rebuildGuides(): void {
    for (const g of [this.laneGroup, this.timeGroup]) {
      g.traverse((o) => { if (o instanceof CSS2DObject) o.element.remove(); });
      disposeObject(g);
      g.clear();
    }
    this.tickLabels.length = 0;
    const zNear = 12;
    const zFar = -(MAP.ROAD_LENGTH_UNITS - 12);
    for (const tick of laneTicks(this.thresholds)) {
      const pts = [new THREE.Vector3(tick.u, 0, zNear), new THREE.Vector3(tick.u, 0, zFar)];
      const color = tick.kind === 'critical' ? '#f87171' : '#c7d2e8';
      const opacity = tick.kind === 'edge' ? 0.6 : tick.kind === 'critical' ? 0.5 : tick.kind === 'linear' ? 0.28 : 0.22;
      const line = makeLine(pts, color, opacity, tick.kind === 'critical' || tick.kind === 'dashed');
      this.laneGroup.add(line);
      const labelled = tick.kind !== 'linear' || Math.abs(tick.km) === 1 || Math.abs(tick.km) === 3;
      if (labelled && (tick.km > 0 || tick.kind === 'edge' || tick.kind === 'critical')) {
        const label = makeLabel('lane', tick.kind === 'critical' || tick.kind === 'edge' ? `${tick.km > 0 ? '' : '−'}${tick.label}` : `${tick.km > 0 ? '+' : '−'}${tick.label}`);
        const row = tick.kind === 'edge' ? 0 : tick.kind === 'critical' ? 1 : Math.abs(tick.km) === 1 ? 2 : 3;
        label.position.set(tick.u, 0, -2.2 - row * 1.3);
        label.center.set(tick.km > 0 ? -0.1 : 1.1, 0.5);
        this.laneGroup.add(label);
      }
    }
    for (const t of timeTicks(this.thresholds.horizonS)) {
      const line = makeLine([new THREE.Vector3(-MAP.EDGE_UNITS, 0, -t.u), new THREE.Vector3(MAP.EDGE_UNITS, 0, -t.u)], '#c7d2e8', 0.14);
      const label = makeLabel('tick', t.label);
      label.position.set(MAP.EDGE_UNITS + 0.4, 0, -t.u);
      label.center.set(0, 0.5);
      this.timeGroup.add(line, label);
      this.tickLabels.push(label);
    }
  }

  // ------------------------------------------------------------------ basis / profile
  private updatePlaneBasis(): void {
    const sel = this.items.find((i) => (this.selectedConjunctionId && i.conjunctionId === this.selectedConjunctionId) || (!this.selectedConjunctionId && i.tier === 'CRITICAL'));
    const ref = sel ?? this.items.find((i) => i.offset);
    this.planeBasis = ref?.offset ? { L: ref.offset.L, U: ref.offset.U } : DEFAULT_PLANE;
  }

  private rebuildProfile(): void {
    if (!this.primaryTraj || !this.maneuverTraj) {
      this.profile = null;
      return;
    }
    const start = this.controller.snapshot.startUnix;
    const end = this.controller.snapshot.endUnix;
    this.profile = ribbonProfile(this.primaryTraj, this.maneuverTraj, this.planeBasis, start, end, 30);
  }

  // ------------------------------------------------------------------ visuals
  private clearVisuals(): void {
    for (const v of [...this.visuals, ...this.chaseVisuals.values()]) {
      v.label.element.remove();
      this.dynamic.remove(v.group);
      disposeObject(v.group);
    }
    this.visuals = [];
    this.chaseVisuals.clear();
    this.pickables.length = 0;
  }

  private makeVisual(item: EncounterItem, chase: boolean, slabIndex: number): Visual {
    const style = styleFor(item.tier, {
      selected: item.objectId === this.selectedObjectId && (!this.selectedConjunctionId || item.conjunctionId === this.selectedConjunctionId),
      mitigated: item.mitigated,
      reducedMotion: this.reducedMotion,
    });
    const group = new THREE.Group();
    const [w, h, d] = chase ? [style.chaseSizeKm, style.chaseSizeKm, style.chaseSizeKm] : [style.size.w, style.size.h, style.size.l];
    const geom = roundedBox(w, h, d);
    const fill = new THREE.MeshBasicMaterial({ color: style.fill, transparent: true, opacity: style.fillOpacity, depthWrite: false });
    const box = new THREE.Mesh(geom, fill);
    box.userData.item = item;
    const edgeGeom = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
    const edgeMat = new THREE.LineBasicMaterial({ color: style.edge, transparent: true, opacity: style.edgeOpacity });
    const edges = new THREE.LineSegments(edgeGeom, edgeMat);
    group.add(box, edges);
    let outline: THREE.LineSegments | null = null;
    let outlineMat: THREE.LineBasicMaterial | null = null;
    if (style.outline) {
      outlineMat = new THREE.LineBasicMaterial({ color: style.outline, transparent: true, opacity: 0.95 });
      outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w * 1.12, h * 1.12, d * 1.12)), outlineMat);
      group.add(outline);
    }
    let stem: THREE.Line | null = null;
    if (!chase) {
      stem = makeLine([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -h / 2, 0)], '#c7d2e8', 0.3);
      group.add(stem);
    }
    const labelKind: LabelKind = item.mitigated ? 'mitigated' : item.tier === 'CRITICAL' ? 'critical' : 'object';
    const label = makeLabel(labelKind, item.name);
    label.position.set(0, h / 2 + (chase ? 0.05 : 0.15), 0);
    group.add(label);
    let trail: THREE.Points | null = null;
    if (item.trail && (item.tier === 'CRITICAL' || item.mitigated)) {
      trail = makePoints(item.trail.rtnKm.length, '#ffffff', chase ? 0.12 : 0.1);
      if (chase) {
        const flat = new Float32Array(item.trail.rtnKm.length * 3);
        item.trail.rtnKm.forEach((p, i) => { const wpos = rtnToWorld(p); flat[i * 3] = wpos[0]; flat[i * 3 + 1] = wpos[1]; flat[i * 3 + 2] = wpos[2]; });
        setPoints(trail, flat);
        this.dynamic.add(trail); // true relative positions, not attached to the box
      } else {
        setPoints(trail, trailMapOffsets(item));
        group.add(trail);
      }
    }
    let danger: THREE.Mesh | null = null;
    if (!chase && item.tier === 'CRITICAL' && !item.mitigated) {
      const half = lateralUnits(this.thresholds.criticalKm, this.thresholds.trackedKm);
      danger = new THREE.Mesh(new THREE.PlaneGeometry(2 * half, 3), new THREE.MeshBasicMaterial({ color: '#ef4444', transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
      danger.rotation.x = -Math.PI / 2;
      danger.position.set(-lateralUnits(item.offset?.x ?? 0, this.thresholds.trackedKm), -h / 2 + 0.01, 0); // centred on the road, not the box
      group.add(danger);
    }
    group.visible = false;
    this.dynamic.add(group);
    this.pickables.push(box);
    return { item, group, box, fill, edges, edgeMat, outline, outlineMat, stem, label, labelKind, trail, danger, style, slabIndex };
  }

  private rebuildVisuals(): void {
    this.clearVisuals();
    let slab = 0;
    for (const item of this.items) {
      const isSlab = item.tcaUnix === null;
      if (isSlab && slab >= MAX_WATCH_SLABS) continue;
      this.visuals.push(this.makeVisual(item, false, isSlab ? slab++ : -1));
    }
    // chase mode: one visual per object, best tier wins
    const best = new Map<string, EncounterItem>();
    for (const item of this.items) {
      const cur = best.get(item.objectId);
      if (!cur || TIER_ORDER.indexOf(item.tier) < TIER_ORDER.indexOf(cur.tier)) best.set(item.objectId, item);
    }
    for (const [oid, item] of best) this.chaseVisuals.set(oid, this.makeVisual(item, true, -1));
    this.applyLayerVisibility();
  }

  private tierAllowed(tier: PerceptionTier): boolean {
    if (tier === 'CRITICAL') return true;
    return this.layers.background;
  }

  private applyLayerVisibility(): void {
    for (const v of this.visuals) if (v.trail) v.trail.visible = this.layers.secondary;
  }

  // ------------------------------------------------------------------ frame loop
  private loop = (): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.loop);
    this.frame++;
    if (this.mini && this.frame % 4 !== 0) return;
    const now = this.controller.currentUnix;
    this.controls.update();
    if (this.mode === 'map') this.updateMap(now);
    else this.updateChase(now);
    this.renderer.render(this.scene, this.camera);
    if (!this.mini) this.labelRenderer.render(this.scene, this.camera);
  };

  /** True when a world position projects into the HUD band at the top of the view. */
  private underHud(obj: THREE.Object3D): boolean {
    obj.getWorldPosition(this.scratch).project(this.camera);
    return this.scratch.y > 0.74 || this.scratch.z > 1;
  }

  private satLateral(now: number): { x: number; y: number } {
    if (!this.approved || !this.profile || !this.maneuverTraj || this.maneuverTraj.burnTimeUnix === null || now < this.maneuverTraj.burnTimeUnix) return { x: 0, y: 0 };
    return sampleProfile(this.profile, now);
  }

  private fillRibbon(ribbon: Ribbon, now: number, useProfile: boolean, halfWidth: number): void {
    const uH = alongUnits(this.thresholds.horizonS);
    for (let k = 0; k < RIBBON_ROWS; k++) {
      const u = (k / (RIBBON_ROWS - 1)) * uH;
      const t = now + inverseAlong(u);
      const off = useProfile && this.profile ? sampleProfile(this.profile, t) : { x: 0, y: 0 };
      this.centers[k * 3] = lateralUnits(off.x, this.thresholds.trackedKm);
      this.centers[k * 3 + 1] = Math.max(-3, Math.min(3, off.y)) * 0.0; // keep the ribbon on the road plane
      this.centers[k * 3 + 2] = -u;
    }
    ribbon.update(this.centers, halfWidth, 0.02);
  }

  private updateMap(now: number): void {
    const thr = this.thresholds;
    const burn = this.maneuverTraj?.burnTimeUnix ?? null;
    const sat = this.satLateral(now);
    this.mapSat.position.set(lateralUnits(sat.x, thr.trackedKm), SAT_Y, 0);
    this.mapSat.visible = true;
    // main ribbon: approved maneuver bends it; otherwise the nominal path
    this.fillRibbon(this.ribbon, now, this.approved, MAP.RIBBON_WIDTH_UNITS / 2);
    this.ribbon.group.visible = true;
    // candidate preview
    const showCandidate = !!this.maneuverTraj && !this.approved && this.layers.candidates;
    this.candidateRibbon.group.visible = showCandidate;
    if (showCandidate) this.fillRibbon(this.candidateRibbon, now, true, MAP.RIBBON_WIDTH_UNITS / 2);
    // ghost of the original path once a maneuver is approved
    const showGhost = this.approved && !!burn && this.layers.original;
    this.ghostLine.visible = showGhost;
    if (showGhost && burn !== null) {
      const z0 = burn > now ? -alongUnits(burn - now) : 0;
      setLinePoints(this.ghostLine, [new THREE.Vector3(0, 0.03, z0), new THREE.Vector3(0, 0.03, -alongUnits(thr.horizonS))]);
    }
    // ghost satellite follows a selected (unapproved) candidate after its burn
    const ghostSat = !!this.maneuverTraj && !this.approved && burn !== null && now >= burn && this.layers.candidates && !!this.profile;
    this.mapGhostSat.visible = ghostSat;
    if (ghostSat && this.profile) this.mapGhostSat.position.set(lateralUnits(sampleProfile(this.profile, now).x, thr.trackedKm), SAT_Y, 0);
    // burn marker
    if (this.maneuver && burn !== null && burn - now > 0 && burn - now < thr.horizonS) {
      this.burnMarker.visible = this.layers.candidates || this.approved;
      this.burnMarker.position.set(0, 0.35, -alongUnits(burn - now));
      setLabel(this.burnLabel, `BURN ${this.maneuver.direction} ${this.maneuver.dv_magnitude_mps.toFixed(2)} m/s · ${fmtCountdown(burn - now)}`);
    } else {
      this.burnMarker.visible = false;
    }
    const doLabels = performance.now() - this.lastLabelUpdate > 100;
    if (doLabels) this.lastLabelUpdate = performance.now();
    if (doLabels) for (const l of this.tickLabels) l.visible = this.layers.labels && !this.underHud(l);
    const pulse = this.reducedMotion ? 1 : 0.75 + 0.25 * Math.sin(performance.now() / 255);
    for (const v of this.visuals) {
      const item = v.item;
      if (!this.tierAllowed(item.tier)) { v.group.visible = false; continue; }
      if (v.slabIndex >= 0) {
        // ML watch object without a verified encounter: parked on the shoulder
        v.group.visible = this.layers.background;
        v.group.position.set(MAP.EDGE_UNITS + 1.2 + (v.slabIndex % 2) * 0.9, v.style.size.h / 2, -4 - Math.floor(v.slabIndex / 2) * 2.2);
        this.setOpacity(v, 0.9);
        if (doLabels) setLabel(v.label, `${item.name} · model ${((item.mlScore ?? 0) * 100).toFixed(0)}% · cleared by physics`);
        v.label.visible = this.layers.labels && item.objectId === this.selectedObjectId;
        continue;
      }
      const pos = objectMapPosition(item, now, thr);
      v.group.visible = pos.visible;
      if (!pos.visible) continue;
      v.group.position.set(pos.x, pos.y + v.style.size.h / 2, pos.z);
      this.setOpacity(v, pos.opacity);
      if (v.outline && v.outlineMat && v.style.pulse) {
        v.outline.scale.setScalar(pulse * 0.08 + 1);
        v.outlineMat.opacity = 0.6 + 0.4 * pulse;
      }
      if (v.danger) v.danger.visible = this.layers.markers;
      const showLabel = this.layers.labels && (v.style.labelMode === 'always' || item.objectId === this.selectedObjectId) && !this.underHud(v.group);
      v.label.visible = showLabel;
      if (showLabel && doLabels) {
        const base = `${item.name} · ${fmtKm(item.missKm)} · ${fmtCountdown(pos.tauS)}`;
        setLabel(v.label, item.mitigated && item.postMissKm !== null ? `${base} → ${fmtKm(item.postMissKm)} after burn` : base);
      }
    }
  }

  private setOpacity(v: Visual, factor: number): void {
    v.fill.opacity = v.style.fillOpacity * factor;
    v.edgeMat.opacity = v.style.edgeOpacity * factor;
    if (v.outlineMat && !v.style.pulse) v.outlineMat.opacity = 0.95 * factor;
    if (v.trail) (v.trail.material as THREE.PointsMaterial).opacity = 0.85 * factor;
  }

  private updateChase(now: number): void {
    const burn = this.maneuverTraj?.burnTimeUnix ?? null;
    const useManeuvered = this.approved && !!this.maneuverTraj && burn !== null && now >= burn;
    const satTraj = useManeuvered ? this.maneuverTraj : this.primaryTraj;
    const s0 = satTraj?.stateAt(now) ?? null;
    this.chaseSat.visible = !!s0;
    this.missLine.visible = false;
    this.missLabel.visible = false;
    this.dangerRing.visible = false;
    if (!s0 || !satTraj) {
      for (const v of this.chaseVisuals.values()) v.group.visible = false;
      this.ribbon.group.visible = false;
      return;
    }
    this.chaseSat.position.set(0, 0, 0);
    // ribbon: the next minute of the orbit at true scale
    const pts = chaseRibbonPoints(satTraj, now, CHASE.RIBBON_AHEAD_S, CHASE.RIBBON_AHEAD_S / (RIBBON_ROWS - 1));
    if (pts.length === RIBBON_ROWS) {
      for (let k = 0; k < RIBBON_ROWS; k++) {
        const wpos = rtnToWorld(pts[k]);
        this.centers[k * 3] = wpos[0];
        this.centers[k * 3 + 1] = wpos[1];
        this.centers[k * 3 + 2] = wpos[2];
      }
      this.ribbon.update(this.centers, CHASE.SAT_SPAN_KM / 2, -0.02);
      this.ribbon.group.visible = true;
    } else {
      this.ribbon.group.visible = false;
    }
    // ghost: the other trajectory (original after approval, candidate when previewing)
    const other = useManeuvered ? this.primaryTraj : this.maneuverTraj && !this.approved && this.layers.candidates ? this.maneuverTraj : null;
    const showGhost = !!other && (useManeuvered ? this.layers.original : true) && burn !== null && now >= burn - 1;
    this.ghostLine.visible = showGhost;
    this.chaseGhostSat.visible = false;
    if (showGhost && other) {
      const gpts: THREE.Vector3[] = [];
      for (let dt = 0; dt <= CHASE.RIBBON_AHEAD_S; dt += 2) {
        const st = other.stateAt(now + dt);
        if (!st) break;
        const rel = relativeStateRtn(s0, st).r;
        // relative to the satellite's current position (approximate: ignores the frame rotation over one minute)
        const w = rtnToWorld(rel);
        gpts.push(new THREE.Vector3(w[0], w[1], w[2]));
      }
      if (gpts.length > 1) setLinePoints(this.ghostLine, gpts);
      else this.ghostLine.visible = false;
      if (gpts.length > 0) {
        this.chaseGhostSat.visible = !useManeuvered;
        this.chaseGhostSat.position.copy(gpts[0]);
      }
    }
    this.candidateRibbon.group.visible = false;
    const doLabels = performance.now() - this.lastLabelUpdate > 100;
    if (doLabels) this.lastLabelUpdate = performance.now();
    const pulse = this.reducedMotion ? 1 : 0.75 + 0.25 * Math.sin(performance.now() / 255);
    let criticalNear: { v: Visual; dist: number; pos: THREE.Vector3 } | null = null;
    for (const v of this.chaseVisuals.values()) {
      const item = v.item;
      const traj = this.trajectories.get(item.objectId);
      const st = traj?.stateAt(now) ?? null;
      if (!st || !this.tierAllowed(item.tier)) { v.group.visible = false; continue; }
      const rel = relativeStateRtn(s0, st);
      const dist = Math.hypot(rel.r[0], rel.r[1], rel.r[2]);
      if (dist > CHASE.VISIBILITY_KM) { v.group.visible = false; continue; }
      const w = rtnToWorld(rel.r);
      v.group.visible = true;
      v.group.position.set(w[0], w[1], w[2]);
      // keep far objects legible: grow the box with distance (schematic, stated in the legend)
      v.group.scale.setScalar(Math.max(1, (dist * CHASE.SIZE_PER_KM) / v.style.chaseSizeKm));
      const fade = dist > CHASE.FADE_FROM_KM ? 1 - (dist - CHASE.FADE_FROM_KM) / (CHASE.VISIBILITY_KM - CHASE.FADE_FROM_KM) : 1;
      this.setOpacity(v, fade);
      if (v.outline && v.outlineMat && v.style.pulse) {
        v.outline.scale.setScalar(pulse * 0.08 + 1);
        v.outlineMat.opacity = 0.6 + 0.4 * pulse;
      }
      const showLabel = this.layers.labels && (v.style.labelMode === 'always' || item.objectId === this.selectedObjectId);
      v.label.visible = showLabel;
      if (showLabel && doLabels) setLabel(v.label, `${item.name} · ${fmtKm(dist)} now · closest ${fmtKm(item.missKm)}`);
      if (v.trail) {
        const near = item.tcaUnix !== null && Math.abs(now - item.tcaUnix) < CHASE.DANGER_WINDOW_S;
        v.trail.visible = near && this.layers.secondary;
      }
      if (item.tier === 'CRITICAL' && (!criticalNear || dist < criticalNear.dist)) criticalNear = { v, dist, pos: v.group.position.clone() };
    }
    // Swing the camera to the side opposite a close critical object so the spacecraft stays in the
    // lower centre of the frame with the threat ahead of it (only while the user is not dragging).
    if (criticalNear && criticalNear.dist < CHASE.LOOK_AT_KM && !this.pointerStart) {
      const dir = criticalNear.pos.clone().setY(0);
      if (dir.lengthSq() > 1e-6) {
        dir.normalize();
        const back = dir.clone().multiplyScalar(-7.2);
        back.y = 3.5;
        this.camera.position.lerp(back, 0.12);
        this.controls.target.lerp(dir.multiplyScalar(2.4), 0.12);
      }
    } else if (!this.pointerStart) {
      this.controls.target.lerp(this.chaseTargetDefault, 0.08);
    }
    if (criticalNear) {
      const item = criticalNear.v.item;
      const nearTca = item.tcaUnix !== null && Math.abs(now - item.tcaUnix) < CHASE.DANGER_WINDOW_S;
      if (nearTca && this.layers.markers && !item.mitigated) {
        this.dangerRing.visible = true;
        this.dangerRing.scale.setScalar(this.thresholds.criticalKm);
        const f = 1 - Math.abs(now - (item.tcaUnix ?? now)) / CHASE.DANGER_WINDOW_S;
        this.dangerRing.children.forEach((c) => ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = (0.2 + 0.5 * f) * ((c as THREE.Mesh).geometry instanceof THREE.RingGeometry ? 1 : 0.35));
      }
      if (criticalNear.dist < CHASE.MISS_LINE_KM && this.layers.markers) {
        this.missLine.visible = true;
        setLinePoints(this.missLine, [new THREE.Vector3(0, 0, 0), criticalNear.pos]);
        this.missLabel.visible = this.layers.labels;
        this.missLabel.position.copy(criticalNear.pos).multiplyScalar(0.5);
        if (doLabels) setLabel(this.missLabel, `${fmtKm(criticalNear.dist)} separation`);
      }
    }
  }

  // ------------------------------------------------------------------ events
  private onPointerDown = (e: PointerEvent): void => {
    this.pointerStart = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent): void => {
    const start = this.pointerStart;
    this.pointerStart = null;
    if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables.filter((m) => m.parent?.visible), false);
    if (hits.length > 0) {
      const item = hits[0].object.userData.item as EncounterItem;
      this.callbacks.onPick(item.objectId, item.conjunctionId);
    } else {
      this.callbacks.onPick(null, null);
    }
  };

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.callbacks.onError?.('WebGL context lost; reload the page to restore the encounter view');
  };

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
