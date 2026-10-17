import * as Cesium from 'cesium';
import type { SpacecraftDesign } from '../types/api';
import { PART_COLORS, designParts, type Axis, type Part } from './designs';

/**
 * Detailed glTF models for designs that have one, already in metres in the body frame (x along
 * velocity, y cross-track, z radial); see scripts/prepare_iss_model.py. `nativeWidthM` is the
 * model's cross-track span, so the model is scaled uniformly to the design's published width.
 */
const MODEL_ASSETS: Record<string, { url: string; nativeWidthM: number; credit: string }> = {
  iss: { url: `${import.meta.env.BASE_URL}models/iss.glb`, nativeWidthM: 109, credit: 'NASA/Michael D. Carbajal' },
};

/** Smallest on-screen size (pixels across the envelope) at which the 3D model replaces the marker. */
const MIN_MODEL_PIXELS = 6;

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

/**
 * True-scale spacecraft model. Designs with a detailed glTF asset (the ISS) load it; every other
 * design is built from the parts in designs.ts, which also stand in while the glTF loads. Sizes
 * come from the backend's design record. One static primitive per spacecraft; its model
 * matrix is updated every frame from the position and velocity (x along velocity, z radial), which
 * is far cheaper and more predictable than per-frame dynamic entity geometry. The model is shown
 * only once it is big enough on screen to read; until then the scene draws a marker instead.
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
  private readonly scaleMatrix = new Cesium.Matrix4();
  private readonly rotation = new Cesium.Matrix3();
  private readonly x = new Cesium.Cartesian3();
  private readonly y = new Cesium.Cartesian3();
  private readonly z = new Cesium.Cartesian3();
  /** Whether the model was drawn this frame (the scene hides the marker while it is). */
  shown = false;

  constructor(scene: Cesium.Scene, design: SpacecraftDesign) {
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
      // the detailed model replaces the part-based placeholder
      if (this.primitive) this.scene.primitives.remove(this.primitive);
      this.primitive = null;
    } catch (err) {
      console.warn(`spacecraft model ${url} failed to load; keeping the part-based model`, err);
    }
  }

  /** Largest camera distance at which the envelope spans MIN_MODEL_PIXELS on screen. */
  private visibleWithin(): number {
    const frustum = this.scene.camera.frustum as Cesium.PerspectiveFrustum;
    const fovy = frustum.fovy ?? Cesium.Math.toRadians(60);
    const radiansPerPixel = fovy / Math.max(1, this.scene.drawingBufferHeight);
    return (2 * this.envelopeRadiusM) / (MIN_MODEL_PIXELS * radiansPerPixel);
  }

  /** positionFixed / velocityFixed in Cesium's Earth-fixed frame (metres, m/s). */
  update(positionFixed: Cesium.Cartesian3, velocityFixed: Cesium.Cartesian3): void {
    const distance = Cesium.Cartesian3.distance(this.scene.camera.positionWC, positionFixed);
    this.shown = distance < this.visibleWithin();
    if (this.primitive) this.primitive.show = this.shown;
    if (this.gltf) this.gltf.show = this.shown;
    if (!this.shown) return;
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
    if (this.primitive) this.primitive.modelMatrix = Cesium.Matrix4.clone(this.matrix, this.primitive.modelMatrix);
    if (this.gltf) {
      this.gltf.modelMatrix = this.gltfScale === 1
        ? Cesium.Matrix4.clone(this.matrix, this.gltf.modelMatrix)
        : Cesium.Matrix4.multiply(this.matrix, this.scaleMatrix, this.gltf.modelMatrix);
    }
  }

  hide(): void {
    this.shown = false;
    if (this.primitive) this.primitive.show = false;
    if (this.gltf) this.gltf.show = false;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.primitive) this.scene.primitives.remove(this.primitive);
    if (this.gltf) this.scene.primitives.remove(this.gltf);
    this.primitive = null;
    this.gltf = null;
    this.shown = false;
  }
}
