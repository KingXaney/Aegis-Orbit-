import * as Cesium from 'cesium';
import type { SpacecraftDesign } from '../types/api';
import { PART_COLORS, designParts, type Axis, type Part } from './designs';

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
 * True-scale spacecraft model built from the parts of the object's design (see designs.ts), whose
 * envelope comes from the backend's design record. One static primitive per spacecraft; its model
 * matrix is updated every frame from the position and velocity (x along velocity, z radial), which
 * is far cheaper and more predictable than per-frame dynamic entity geometry. The model is shown
 * only once it is big enough on screen to read; until then the scene draws a marker instead.
 */
export class SpacecraftModel {
  readonly design: SpacecraftDesign;
  readonly envelopeRadiusM: number;
  private readonly scene: Cesium.Scene;
  private primitive: Cesium.Primitive | null;
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
    const p = this.primitive;
    if (!p) return;
    const distance = Cesium.Cartesian3.distance(this.scene.camera.positionWC, positionFixed);
    this.shown = p.show = distance < this.visibleWithin();
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
    p.modelMatrix = Cesium.Matrix4.fromRotationTranslation(this.rotation, positionFixed, p.modelMatrix);
  }

  hide(): void {
    this.shown = false;
    if (this.primitive) this.primitive.show = false;
  }

  destroy(): void {
    if (this.primitive) this.scene.primitives.remove(this.primitive);
    this.primitive = null;
    this.shown = false;
  }
}
