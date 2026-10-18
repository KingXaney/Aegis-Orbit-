import * as Cesium from 'cesium';
import type { SpacecraftDesign } from '../types/api';
import type { Vec3 } from '../simulation/trajectory';
import { MODEL_ASSETS, PART_COLORS, designParts, type Axis, type Part } from './designs';
import { NOZZLE_FACES, plumeSpec, rcsNozzles, type NozzleFace } from './thrusters';

/** Smallest on-screen size (pixels across the envelope) at which the 3D model replaces the marker. */
const MIN_MODEL_PIXELS = 6;
const PLUME_COLOR = Cesium.Color.fromCssColorString('#a3e635');
const PLUME_CORE_COLOR = Cesium.Color.fromCssColorString('#f7fee7');

const AXIS_ROTATION: Record<Axis, Cesium.Matrix3> = {
  z: Cesium.Matrix3.IDENTITY,
  x: Cesium.Matrix3.fromRotationY(Cesium.Math.PI_OVER_TWO), // cylinder +z -> +x
  y: Cesium.Matrix3.fromRotationX(-Cesium.Math.PI_OVER_TWO), // cylinder +z -> +y
};

function partInstance(part: Part): Cesium.GeometryInstance {
  const vertexFormat = Cesium.PerInstanceColorAppearance.VERTEX_FORMAT;
  const color = Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString(PART_COLORS[part.color]));
  const center = new Cesium.Cartesian3(...part.center);
  if (part.kind === 'box') {
    return new Cesium.GeometryInstance({
      geometry: Cesium.BoxGeometry.fromDimensions({ dimensions: new Cesium.Cartesian3(...part.size), vertexFormat }),
      modelMatrix: Cesium.Matrix4.fromTranslation(center),
      attributes: { color },
    });
  }
  return new Cesium.GeometryInstance({
    geometry: new Cesium.CylinderGeometry({
      length: part.length,
      topRadius: part.radiusPos,
      bottomRadius: part.radiusNeg,
      slices: 24,
      vertexFormat,
    }),
    modelMatrix: Cesium.Matrix4.fromRotationTranslation(AXIS_ROTATION[part.axis], center),
    attributes: { color },
  });
}

/** A rotation that takes the cylinder axis (+z) to `dir`, a unit vector in the body frame. */
function rotationToZ(dir: Vec3): Cesium.Matrix3 {
  const z = new Cesium.Cartesian3(dir[0], dir[1], dir[2]);
  const helper = Math.abs(dir[2]) < 0.9 ? Cesium.Cartesian3.UNIT_Z : Cesium.Cartesian3.UNIT_X;
  const x = Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(helper, z, new Cesium.Cartesian3()), new Cesium.Cartesian3());
  const y = Cesium.Cartesian3.cross(z, x, new Cesium.Cartesian3());
  return Cesium.Matrix3.fromColumnMajorArray([x.x, x.y, x.z, y.x, y.y, y.z, z.x, z.y, z.z]);
}

/** A cone along `dir` centred at `center`: `topRadius` at the far (+dir) end. */
function coneInstance(center: Vec3, dir: Vec3, length: number, topRadius: number, bottomRadius: number, color?: Cesium.Color): Cesium.GeometryInstance {
  const vertexFormat = color ? Cesium.PerInstanceColorAppearance.VERTEX_FORMAT : Cesium.MaterialAppearance.MaterialSupport.BASIC.vertexFormat;
  return new Cesium.GeometryInstance({
    geometry: new Cesium.CylinderGeometry({ length, topRadius, bottomRadius, slices: 20, vertexFormat }),
    modelMatrix: Cesium.Matrix4.fromRotationTranslation(rotationToZ(dir), new Cesium.Cartesian3(...center)),
    attributes: color ? { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) } : undefined,
  });
}

function plumePrimitive(scene: Cesium.Scene, design: SpacecraftDesign, face: NozzleFace, radiusFactor: number, lengthFactor: number): Cesium.Primitive {
  const spec = plumeSpec(design, face);
  const length = spec.length * lengthFactor;
  // shorter cones stay anchored at the nozzle exit
  const start = spec.center.map((c, i) => c - spec.dir[i] * spec.length / 2) as Vec3;
  const center = start.map((c, i) => c + spec.dir[i] * length / 2) as Vec3;
  return scene.primitives.add(
    new Cesium.Primitive({
      geometryInstances: [coneInstance(center, spec.dir, length, spec.baseRadius * radiusFactor, spec.baseRadius * 0.15 * radiusFactor)],
      appearance: new Cesium.MaterialAppearance({
        material: Cesium.Material.fromType('Color', { color: PLUME_COLOR.withAlpha(0.5) }),
        translucent: true,
        closed: false,
        flat: true,
        faceForward: false,
      }),
      asynchronous: false,
      show: false,
    }),
  );
}

function setPlumeColor(primitive: Cesium.Primitive, color: Cesium.Color, alpha: number): void {
  const material = (primitive.appearance as Cesium.MaterialAppearance).material;
  material.uniforms.color = Cesium.Color.clone(color, material.uniforms.color as Cesium.Color | undefined);
  (material.uniforms.color as Cesium.Color).alpha = alpha;
}

export interface SpacecraftModelOptions {
  /** Draw reaction-control nozzles on the core faces and a plume when a burn fires. */
  rcs?: boolean;
}

/**
 * True-scale spacecraft model. Designs with a detailed glTF asset (ISS, GPM) load it; every other
 * design is built from the parts in designs.ts, which also stand in while the glTF loads. Sizes
 * come from the backend's design record. One static primitive per spacecraft; its model
 * matrix is updated every frame from the position and velocity (x along velocity, z radial), which
 * is far cheaper and more predictable than per-frame dynamic entity geometry. The model is shown
 * only once it is big enough on screen to read; until then the scene draws a marker instead.
 * `displayScale` enlarges the whole model uniformly (sandbox junk near the spacecraft).
 */
export class SpacecraftModel {
  readonly design: SpacecraftDesign;
  readonly envelopeRadiusM: number;
  private readonly scene: Cesium.Scene;
  /** Part-based model: the whole model for most designs, a placeholder while a glTF loads. */
  private primitive: Cesium.Primitive | null;
  private gltf: Cesium.Model | null = null;
  private gltfScale = 1;
  private destroyed = false;
  private readonly matrix = new Cesium.Matrix4();
  private readonly scaledMatrix = new Cesium.Matrix4();
  private readonly scaleMatrix = new Cesium.Matrix4();
  private readonly rotation = new Cesium.Matrix3();
  private readonly x = new Cesium.Cartesian3();
  private readonly y = new Cesium.Cartesian3();
  private readonly z = new Cesium.Cartesian3();
  private rcs: Cesium.Primitive | null = null;
  private readonly plumes = new Map<NozzleFace, { outer: Cesium.Primitive; core: Cesium.Primitive }>();
  /** Whether the model was drawn this frame (the scene hides the marker while it is). */
  shown = false;
  /** Uniform enlargement applied this frame (1 = true scale). */
  displayScale = 1;

  constructor(scene: Cesium.Scene, design: SpacecraftDesign, options: SpacecraftModelOptions = {}) {
    this.scene = scene;
    this.design = design;
    this.envelopeRadiusM = 0.5 * Math.hypot(design.length_m, design.width_m, design.height_m);
    this.primitive = scene.primitives.add(
      new Cesium.Primitive({
        geometryInstances: designParts(design).map(partInstance),
        appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true }),
        asynchronous: false,
        show: false,
      }),
    );
    if (options.rcs) {
      const nozzleColor = Cesium.Color.fromCssColorString(PART_COLORS.nozzle);
      this.rcs = scene.primitives.add(
        new Cesium.Primitive({
          geometryInstances: rcsNozzles(design).map((n) => coneInstance(n.center, n.dir, n.length, n.exitRadius, 0.35 * n.exitRadius, nozzleColor)),
          appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true }),
          asynchronous: false,
          show: false,
        }),
      );
      for (const face of NOZZLE_FACES) {
        this.plumes.set(face, { outer: plumePrimitive(scene, design, face, 1, 1), core: plumePrimitive(scene, design, face, 0.4, 0.6) });
      }
    }
    const asset = MODEL_ASSETS[design.design_id];
    if (asset) void this.loadGltf(asset.url, design.width_m / asset.nativeWidthM);
  }

  private async loadGltf(url: string, scale: number): Promise<void> {
    try {
      const model = await Cesium.Model.fromGltfAsync({
        url,
        upAxis: Cesium.Axis.Z, // the asset is already in the body frame; no glTF axis conversion
        forwardAxis: Cesium.Axis.X,
        show: false,
        backFaceCulling: false,
      });
      if (this.destroyed) {
        model.destroy();
        return;
      }
      this.gltf = this.scene.primitives.add(model);
      this.gltfScale = scale;
      Cesium.Matrix4.fromUniformScale(scale, this.scaleMatrix);
      // the detailed model replaces the part-based placeholder (the nozzles stay)
      if (this.primitive) this.scene.primitives.remove(this.primitive);
      this.primitive = null;
    } catch (err) {
      console.warn(`spacecraft model ${url} failed to load; keeping the part-based model`, err);
    }
  }

  private radiansPerPixel(): number {
    const frustum = this.scene.camera.frustum as Cesium.PerspectiveFrustum;
    const fovy = frustum.fovy ?? Cesium.Math.toRadians(60);
    return fovy / Math.max(1, this.scene.drawingBufferHeight);
  }

  /** On-screen size of the envelope (pixels) at a camera distance, drawn at `scale`. */
  pixelsAcross(distanceM: number, scale = 1): number {
    return (2 * this.envelopeRadiusM * scale) / (Math.max(distanceM, 1e-3) * this.radiansPerPixel());
  }

  /** Largest camera distance at which the envelope spans MIN_MODEL_PIXELS on screen. */
  private visibleWithin(scale: number): number {
    return (2 * this.envelopeRadiusM * scale) / (MIN_MODEL_PIXELS * this.radiansPerPixel());
  }

  /** The enlargement that makes the envelope span `minPixels` at `distanceM`, between 1 and `maxBoost`. */
  boostFor(distanceM: number, minPixels: number, maxBoost: number): number {
    const px = this.pixelsAcross(distanceM, 1);
    if (!(px > 0)) return maxBoost;
    return Math.min(maxBoost, Math.max(1, minPixels / px));
  }

  /** positionFixed / velocityFixed in Cesium's Earth-fixed frame (metres, m/s). */
  update(positionFixed: Cesium.Cartesian3, velocityFixed: Cesium.Cartesian3, displayScale = 1): void {
    const distance = Cesium.Cartesian3.distance(this.scene.camera.positionWC, positionFixed);
    this.displayScale = displayScale;
    // a degenerate state (NaN, or a zero velocity) has no orientation: skip the frame rather than feed Cesium NaNs
    const usable = Number.isFinite(distance) && Cesium.Cartesian3.magnitudeSquared(velocityFixed) > 0;
    this.shown = usable && distance < this.visibleWithin(displayScale);
    if (this.primitive) this.primitive.show = this.shown;
    if (this.gltf) this.gltf.show = this.shown;
    if (this.rcs) this.rcs.show = this.shown;
    if (!this.shown) {
      this.hidePlumes();
      return;
    }
    Cesium.Cartesian3.normalize(velocityFixed, this.x);
    Cesium.Cartesian3.normalize(positionFixed, this.z);
    Cesium.Cartesian3.cross(this.z, this.x, this.y);
    Cesium.Cartesian3.normalize(this.y, this.y);
    Cesium.Cartesian3.cross(this.x, this.y, this.z); // re-orthogonalise z
    // columns = body axes expressed in the fixed frame
    Cesium.Matrix3.fromColumnMajorArray(
      [this.x.x, this.x.y, this.x.z, this.y.x, this.y.y, this.y.z, this.z.x, this.z.y, this.z.z],
      this.rotation,
    );
    Cesium.Matrix4.fromRotationTranslation(this.rotation, positionFixed, this.matrix);
    const scaled = displayScale === 1 ? this.matrix : Cesium.Matrix4.multiplyByUniformScale(this.matrix, displayScale, this.scaledMatrix);
    if (this.primitive) this.primitive.modelMatrix = Cesium.Matrix4.clone(scaled, this.primitive.modelMatrix);
    if (this.rcs) this.rcs.modelMatrix = Cesium.Matrix4.clone(scaled, this.rcs.modelMatrix);
    for (const p of this.plumes.values()) {
      p.outer.modelMatrix = Cesium.Matrix4.clone(scaled, p.outer.modelMatrix);
      p.core.modelMatrix = Cesium.Matrix4.clone(scaled, p.core.modelMatrix);
    }
    if (this.gltf) {
      this.gltf.modelMatrix = this.gltfScale === 1
        ? Cesium.Matrix4.clone(scaled, this.gltf.modelMatrix)
        : Cesium.Matrix4.multiply(scaled, this.scaleMatrix, this.gltf.modelMatrix);
    }
  }

  /** Light the plume of one nozzle at `intensity` (0..1), or none. Only drawn while the model is. */
  setPlume(face: NozzleFace | null, intensity: number): void {
    if (this.plumes.size === 0) return;
    const on = face !== null && intensity > 0 && this.shown;
    for (const [f, p] of this.plumes) {
      const show = on && f === face;
      p.outer.show = show;
      p.core.show = show;
      if (show) {
        setPlumeColor(p.outer, PLUME_COLOR, 0.55 * intensity);
        setPlumeColor(p.core, PLUME_CORE_COLOR, 0.85 * intensity);
      }
    }
  }

  private hidePlumes(): void {
    for (const p of this.plumes.values()) {
      p.outer.show = false;
      p.core.show = false;
    }
  }

  hide(): void {
    this.shown = false;
    if (this.primitive) this.primitive.show = false;
    if (this.gltf) this.gltf.show = false;
    if (this.rcs) this.rcs.show = false;
    this.hidePlumes();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.primitive) this.scene.primitives.remove(this.primitive);
    if (this.gltf) this.scene.primitives.remove(this.gltf);
    if (this.rcs) this.scene.primitives.remove(this.rcs);
    for (const p of this.plumes.values()) {
      this.scene.primitives.remove(p.outer);
      this.scene.primitives.remove(p.core);
    }
    this.plumes.clear();
    this.primitive = null;
    this.gltf = null;
    this.rcs = null;
    this.shown = false;
  }
}
