import * as Cesium from 'cesium';
import { SampledTrajectory } from '../simulation/trajectory';
import type { SimulationController } from '../simulation/controller';
import type { Conjunction, Maneuver, ObjectSummary, ScenarioDetail, Trajectory } from '../types/api';
import { TimeBridge, temeToFixed, temeVelocityToFixed } from './frames';
import { SpacecraftModel } from './spacecraft';

export interface LayerFlags {
  original: boolean;
  secondary: boolean;
  candidates: boolean;
  background: boolean;
  backgroundOrbits: boolean;
  markers: boolean;
  labels: boolean;
}

export type CameraMode = 'follow' | 'free';

export interface SceneCallbacks {
  onPick: (kind: 'object' | 'candidate' | null, id: string | null) => void;
}

const COLORS = {
  primary: Cesium.Color.fromCssColorString('#67e8f9'),
  tracked: Cesium.Color.fromCssColorString('#93c5fd'),
  debris: Cesium.Color.fromCssColorString('#cbd5e1'),
  threat: Cesium.Color.fromCssColorString('#f87171'),
  candidate: Cesium.Color.fromCssColorString('#4ade80'),
  approved: Cesium.Color.fromCssColorString('#22c55e'),
  burn: Cesium.Color.fromCssColorString('#a3e635'),
  label: Cesium.Color.fromCssColorString('#d7e1f2'),
};

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

function objectColor(o: ObjectSummary): Cesium.Color {
  if (o.category === 'DEBRIS') return COLORS.debris;
  return COLORS.tracked;
}

export class GlobeScene {
  readonly viewer: Cesium.Viewer;
  private readonly controller: SimulationController;
  private readonly callbacks: SceneCallbacks;
  private bridge = new TimeBridge(0);
  private trajectories = new Map<string, SampledTrajectory>();
  private objects = new Map<string, ObjectSummary>();
  private objectEntities = new Map<string, Cesium.Entity>();
  private objectPaths = new Map<string, Cesium.Entity>();
  private primaryId: string | null = null;
  private primaryEntity: Cesium.Entity | null = null;
  private periodS = 5600;
  private conjunction: Conjunction | null = null;
  private conjunctionEntities: Cesium.Entity[] = [];
  private candidateEntities = new Map<string, Cesium.Entity[]>();
  private candidateTrajectories = new Map<string, SampledTrajectory>();
  private candidates: Maneuver[] = [];
  private approvedCandidateId: string | null = null;
  private layers: LayerFlags = { original: true, secondary: true, candidates: true, background: true, backgroundOrbits: false, markers: true, labels: true };
  private cameraMode: CameraMode = 'follow';
  private handler: Cesium.ScreenSpaceEventHandler;
  private preUpdateRemover: Cesium.Event.RemoveCallback;
  private postRenderRemover: Cesium.Event.RemoveCallback;
  private destroyed = false;
  private lastFixedPrimary = new Cesium.Cartesian3();
  private spacecraft: SpacecraftModel;
  private primaryTrajectory: SampledTrajectory | null = null;
  private scratchVel = new Cesium.Cartesian3();

  constructor(container: HTMLElement, controller: SimulationController, callbacks: SceneCallbacks, ionToken?: string) {
    this.controller = controller;
    this.callbacks = callbacks;
    if (ionToken) Cesium.Ion.defaultAccessToken = ionToken;
    const baseLayer = ionToken
      ? Cesium.ImageryLayer.fromWorldImagery({})
      : Cesium.ImageryLayer.fromProviderAsync(
          Cesium.TileMapServiceImageryProvider.fromUrl(Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII')),
        );
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
      skyAtmosphere: new Cesium.SkyAtmosphere(),
      requestRenderMode: false,
    });
    const scene = this.viewer.scene;
    scene.globe.enableLighting = true;
    scene.globe.showGroundAtmosphere = true;
    scene.globe.baseColor = Cesium.Color.fromCssColorString('#06101f');
    scene.backgroundColor = Cesium.Color.fromCssColorString('#02040a');
    scene.highDynamicRange = false;
    scene.screenSpaceCameraController.minimumZoomDistance = 2000;
    scene.screenSpaceCameraController.maximumZoomDistance = 80_000_000;
    scene.fog.enabled = false;
    this.viewer.clock.shouldAnimate = false;
    this.viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;

    this.spacecraft = new SpacecraftModel(scene);
    // Cesium evaluates entity positions during clock.tick(), before preUpdate. The simulation
    // controller therefore sets the clock for the *next* frame in postRender, and everything
    // rendered in a frame (entities, polylines, the spacecraft primitives, the tracked camera)
    // uses the same clock time.
    this.viewer.clock.currentTime = this.bridge.toJulian(this.controller.currentUnix, this.viewer.clock.currentTime);
    this.preUpdateRemover = scene.preUpdate.addEventListener(() => {
      const time = this.viewer.clock.currentTime;
      const st = this.primaryTrajectory?.stateAt(this.bridge.toUnix(time));
      if (st) {
        const pos = temeToFixed(time, st.p, this.lastFixedPrimary);
        const vel = temeVelocityToFixed(time, st.v, pos, this.scratchVel);
        this.spacecraft.update(pos, vel);
      } else {
        this.spacecraft.hide();
      }
    });
    this.postRenderRemover = scene.postRender.addEventListener(() => {
      this.viewer.clock.currentTime = this.bridge.toJulian(this.controller.currentUnix, this.viewer.clock.currentTime);
    });

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
  }

  // ------------------------------------------------------------------ helpers
  private unixOf(time: Cesium.JulianDate | undefined): number {
    return time ? this.bridge.toUnix(time) : this.controller.currentUnix;
  }

  private positionProperty(traj: SampledTrajectory): Cesium.CallbackPositionProperty {
    return new Cesium.CallbackPositionProperty((time, result) => {
      const p = traj.positionAt(this.unixOf(time));
      if (!p) return undefined;
      return temeToFixed(time ?? this.bridge.toJulian(this.controller.currentUnix), p, result);
    }, false, Cesium.ReferenceFrame.FIXED);
  }

  private staticPositionProperty(p: [number, number, number]): Cesium.CallbackPositionProperty {
    return new Cesium.CallbackPositionProperty((time, result) => {
      return temeToFixed(time ?? this.bridge.toJulian(this.controller.currentUnix), p, result);
    }, false, Cesium.ReferenceFrame.FIXED);
  }

  /** Polyline positions for a time span of a trajectory, re-rotated into the fixed frame each frame. */
  private pathPositions(
    traj: SampledTrajectory,
    span: (now: number) => [number, number] | null,
  ): Cesium.CallbackProperty {
    return new Cesium.CallbackProperty((time) => {
      const now = this.unixOf(time);
      const s = span(now);
      if (!s) return [];
      const jd = time ?? this.bridge.toJulian(now);
      const pts = traj.pointsBetween(s[0], s[1], 1200);
      if (pts.length < 2) return [];
      return pts.map((pt) => temeToFixed(jd, pt.p));
    }, false);
  }

  private dash(color: Cesium.Color, gap = 12): Cesium.PolylineDashMaterialProperty {
    return new Cesium.PolylineDashMaterialProperty({ color, dashLength: gap, gapColor: Cesium.Color.TRANSPARENT });
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

  // ------------------------------------------------------------------ scenario
  setScenario(detail: ScenarioDetail, objects: ObjectSummary[], trajectories: Trajectory[]): void {
    this.clearScenario();
    this.bridge = new TimeBridge(detail.window.start_unix);
    this.viewer.clock.currentTime = this.bridge.toJulian(this.controller.currentUnix, this.viewer.clock.currentTime);
    this.primaryId = detail.primary_id;
    for (const o of objects) this.objects.set(o.object_id, o);
    for (const t of trajectories) this.trajectories.set(t.object_id, new SampledTrajectory(t));
    const primary = this.objects.get(detail.primary_id);
    this.periodS = primary?.period_s ?? 5600;

    for (const t of trajectories) {
      const traj = this.trajectories.get(t.object_id)!;
      const obj = this.objects.get(t.object_id);
      if (!obj || traj.length === 0) continue;
      const isPrimary = t.object_id === detail.primary_id;
      const isHighlight = detail.highlight_object_ids.includes(t.object_id);
      const color = isPrimary ? COLORS.primary : isHighlight ? COLORS.threat : objectColor(obj);
      const pos = this.positionProperty(traj);
      const entity = this.viewer.entities.add({
        id: `obj:${t.object_id}`,
        name: obj.name,
        position: pos,
        point: {
          pixelSize: isPrimary ? 9 : isHighlight ? 7 : 5,
          color,
          outlineColor: Cesium.Color.fromCssColorString('#05080f'),
          outlineWidth: 1.5,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: new Cesium.CallbackProperty(() => isPrimary || isHighlight || this.layers.background, false),
        },
        label: this.labelGraphics(obj.name, color, isPrimary ? -22 : -12),
      });
      if (!isPrimary && !isHighlight) {
        // background labels only when close enough to matter
        entity.label!.distanceDisplayCondition = new Cesium.ConstantProperty(new Cesium.DistanceDisplayCondition(0, 3.5e6));
        entity.label!.show = new Cesium.CallbackProperty(() => this.layers.labels && this.layers.background, false);
      }
      this.objectEntities.set(t.object_id, entity);

      if (isPrimary) {
        this.primaryTrajectory = traj;
        // Tracking offset (metres, entity-local frame): far enough to read the orbit's curvature and the Earth limb.
        entity.viewFrom = new Cesium.Cartesian3(-420_000, 180_000, 160_000);
        this.primaryEntity = entity;
        this.addPrimaryModel(pos);
        this.addPrimaryPath(traj);
      } else {
        this.addObjectPath(t.object_id, traj, color, isHighlight);
      }
    }
    this.applyCameraMode();
  }

  private addPrimaryModel(pos: Cesium.PositionProperty): void {
    // Far away: a billboard icon. Close: the procedural spacecraft primitives (see SpacecraftModel).
    const icon = this.viewer.entities.add({
      id: 'primary-icon',
      position: pos,
      billboard: {
        image: `data:image/svg+xml;charset=utf-8,${SATELLITE_SVG}`,
        width: 28,
        height: 28,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(1.5e6, Number.POSITIVE_INFINITY),
      },
    });
    this.objectPaths.set('primary-icon', icon);
  }

  private addPrimaryPath(traj: SampledTrajectory): void {
    const P = this.periodS;
    // Past trail (solid, dim): one orbit behind the current time.
    const trail = this.viewer.entities.add({
      id: 'path:primary:past',
      polyline: {
        positions: this.pathPositions(traj, (now) => [now - P, now]),
        width: 1.5,
        material: COLORS.primary.withAlpha(0.35),
        arcType: Cesium.ArcType.NONE,
        show: new Cesium.CallbackProperty(() => this.layers.original, false),
      },
    });
    // Predicted path (dashed): one orbit ahead; after an approved burn it stops at the burn time.
    const future = this.viewer.entities.add({
      id: 'path:primary:future',
      polyline: {
        positions: this.pathPositions(traj, (now) => {
          const end = now + P;
          const approved = this.approvedCandidateId ? this.candidateTrajectories.get(this.approvedCandidateId) : null;
          if (approved?.burnTimeUnix && now >= approved.burnTimeUnix) {
            return this.layers.original ? [now, end] : null; // original kept for comparison
          }
          return [now, approved?.burnTimeUnix ? Math.min(end, approved.burnTimeUnix) : end];
        }),
        width: 2,
        material: this.dash(COLORS.primary.withAlpha(0.9)),
        arcType: Cesium.ArcType.NONE,
        show: new Cesium.CallbackProperty(() => this.layers.original, false),
      },
    });
    this.objectPaths.set('path:primary:past', trail);
    this.objectPaths.set('path:primary:future', future);
  }

  private addObjectPath(objectId: string, traj: SampledTrajectory, color: Cesium.Color, isHighlight: boolean): void {
    const P = this.objects.get(objectId)?.period_s ?? this.periodS;
    const entity = this.viewer.entities.add({
      id: `path:${objectId}`,
      polyline: {
        positions: this.pathPositions(traj, (now) => [now - P * 0.5, now + P]),
        width: isHighlight ? 2 : 1,
        material: this.dash(color.withAlpha(isHighlight ? 0.85 : 0.4), isHighlight ? 12 : 8),
        arcType: Cesium.ArcType.NONE,
        show: new Cesium.CallbackProperty(() => (isHighlight ? this.layers.secondary : this.layers.backgroundOrbits && this.layers.background), false),
      },
    });
    this.objectPaths.set(`path:${objectId}`, entity);
  }

  // ------------------------------------------------------------------ conjunction
  setConjunction(conj: Conjunction | null): void {
    for (const e of this.conjunctionEntities) this.viewer.entities.remove(e);
    this.conjunctionEntities = [];
    this.conjunction = conj;
    if (!conj) return;
    const rp = conj.primary_state_teme.r_km as [number, number, number];
    const rs = conj.secondary_state_teme.r_km as [number, number, number];
    const mid: [number, number, number] = [(rp[0] + rs[0]) / 2, (rp[1] + rs[1]) / 2, (rp[2] + rs[2]) / 2];
    const show = new Cesium.CallbackProperty(() => this.layers.markers, false);
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

  // ------------------------------------------------------------------ candidates
  setCandidates(candidates: Maneuver[], trajectories: Record<string, Trajectory>, selectedId: string | null, approvedId: string | null): void {
    for (const list of this.candidateEntities.values()) for (const e of list) this.viewer.entities.remove(e);
    this.candidateEntities.clear();
    this.candidateTrajectories.clear();
    this.candidates = candidates;
    this.approvedCandidateId = approvedId;
    for (const cand of candidates) {
      const t = trajectories[cand.maneuver_id];
      if (!t) continue;
      const traj = new SampledTrajectory(t);
      this.candidateTrajectories.set(cand.maneuver_id, traj);
      const isApproved = approvedId === cand.maneuver_id;
      const isSelected = selectedId === cand.maneuver_id;
      const color = isApproved ? COLORS.approved : COLORS.candidate;
      const burn = cand.burn_time_unix;
      const showPath = new Cesium.CallbackProperty(() => this.layers.candidates || isApproved, false);
      const entities: Cesium.Entity[] = [];
      entities.push(
        this.viewer.entities.add({
          id: `cand:${cand.maneuver_id}#path`,
          polyline: {
            positions: this.pathPositions(traj, (now) => {
              const start = Math.max(burn, now - this.periodS);
              const end = Math.max(cand.post_tca_unix + 900, now + this.periodS);
              return start < end ? [start, end] : null;
            }),
            width: isApproved ? 3 : isSelected ? 2.5 : 1.2,
            material: isApproved ? color : this.dash(color.withAlpha(isSelected ? 0.95 : 0.45), 10),
            arcType: Cesium.ArcType.NONE,
            show: showPath,
          },
        }),
        this.viewer.entities.add({
          id: `cand:${cand.maneuver_id}#burn`,
          position: this.staticPositionProperty(cand.burn_state_teme.r_km as [number, number, number]),
          point: {
            pixelSize: isSelected || isApproved ? 9 : 6,
            color: COLORS.burn,
            outlineColor: Cesium.Color.fromCssColorString('#05080f'),
            outlineWidth: 1.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            show: showPath,
          },
          label: {
            ...this.labelGraphics(`BURN ${cand.direction} ${cand.dv_magnitude_mps.toFixed(2)} m/s`, COLORS.burn, 22),
            show: new Cesium.CallbackProperty(() => this.layers.labels && (isSelected || isApproved), false),
          },
        }),
      );
      if (isSelected || isApproved) {
        // the maneuvered primary as a moving ghost marker after the burn
        entities.push(
          this.viewer.entities.add({
            id: `cand:${cand.maneuver_id}#ghost`,
            position: this.positionProperty(traj),
            point: {
              pixelSize: 6,
              color: color.withAlpha(0.9),
              outlineColor: Cesium.Color.fromCssColorString('#05080f'),
              outlineWidth: 1,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              show: new Cesium.CallbackProperty(() => (this.layers.candidates || isApproved) && this.controller.currentUnix >= burn, false),
            },
            label: {
              ...this.labelGraphics(isApproved ? 'MANEUVERED (APPROVED)' : 'MANEUVERED (CANDIDATE)', color, 24),
              show: new Cesium.CallbackProperty(() => this.layers.labels && (this.layers.candidates || isApproved) && this.controller.currentUnix >= burn, false),
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

  // ------------------------------------------------------------------ layers / camera
  setLayers(layers: LayerFlags): void {
    this.layers = { ...layers };
  }

  setCameraMode(mode: CameraMode): void {
    this.cameraMode = mode;
    this.applyCameraMode();
  }

  private applyCameraMode(): void {
    if (this.destroyed) return;
    if (this.cameraMode === 'follow' && this.primaryEntity) {
      this.viewer.trackedEntity = this.primaryEntity;
    } else {
      this.viewer.trackedEntity = undefined;
      this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    }
  }

  resetCamera(): void {
    this.viewer.trackedEntity = undefined;
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    const traj = this.primaryId ? this.trajectories.get(this.primaryId) : null;
    const p = traj?.positionAt(this.controller.currentUnix);
    if (p && this.cameraMode === 'free') {
      const fixed = temeToFixed(this.bridge.toJulian(this.controller.currentUnix), p, this.lastFixedPrimary);
      const carto = Cesium.Cartographic.fromCartesian(fixed);
      this.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, 18_000_000),
        duration: 1.2,
      });
    } else {
      this.applyCameraMode();
      if (this.primaryEntity) {
        this.viewer.trackedEntity = this.primaryEntity;
      }
    }
  }

  flyToPrimary(): void {
    if (this.primaryEntity) {
      this.cameraMode = 'follow';
      this.viewer.trackedEntity = undefined;
      this.viewer.trackedEntity = this.primaryEntity;
    }
  }

  // ------------------------------------------------------------------ cleanup
  private clearScenario(): void {
    this.setConjunction(null);
    this.setCandidates([], {}, null, null);
    this.viewer.trackedEntity = undefined;
    this.viewer.entities.removeAll();
    this.objectEntities.clear();
    this.objectPaths.clear();
    this.trajectories.clear();
    this.objects.clear();
    this.primaryEntity = null;
    this.primaryId = null;
    this.primaryTrajectory = null;
    this.spacecraft.hide();
  }

  destroy(): void {
    this.destroyed = true;
    this.preUpdateRemover();
    this.postRenderRemover();
    this.spacecraft.destroy();
    this.handler.destroy();
    this.viewer.destroy();
  }

  get currentConjunction(): Conjunction | null {
    return this.conjunction;
  }

  get currentCandidates(): Maneuver[] {
    return this.candidates;
  }
}
