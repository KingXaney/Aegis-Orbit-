import * as Cesium from 'cesium';

/**
 * Procedural spacecraft (bus + two solar panels + antenna) built from static
 * box primitives. The model matrix is updated every frame from the satellite's
 * position and velocity (x along velocity, z radial), which is far cheaper and
 * more predictable than per-frame dynamic entity geometry. Dimensions are in
 * metres and deliberately enlarged for visibility; the legend says so.
 */
export class SpacecraftModel {
  private readonly scene: Cesium.Scene;
  private readonly primitives: Cesium.Primitive[] = [];
  private readonly rotation = new Cesium.Matrix3();
  private readonly matrix = new Cesium.Matrix4();
  private readonly x = new Cesium.Cartesian3();
  private readonly y = new Cesium.Cartesian3();
  private readonly z = new Cesium.Cartesian3();
  visibleWithin = 1.5e6; // metres from the camera

  constructor(scene: Cesium.Scene) {
    this.scene = scene;
    const bus = Cesium.Color.fromCssColorString('#c7d2fe');
    const panel = Cesium.Color.fromCssColorString('#1e40af');
    const gold = Cesium.Color.fromCssColorString('#d4a853');
    this.add(new Cesium.Cartesian3(9000, 5000, 5000), new Cesium.Cartesian3(0, 0, 0), bus);
    this.add(new Cesium.Cartesian3(2600, 14000, 220), new Cesium.Cartesian3(0, 10500, 0), panel);
    this.add(new Cesium.Cartesian3(2600, 14000, 220), new Cesium.Cartesian3(0, -10500, 0), panel);
    this.add(new Cesium.Cartesian3(600, 7000, 600), new Cesium.Cartesian3(0, 0, 0), gold); // panel boom
    this.add(new Cesium.Cartesian3(2200, 2200, 3200), new Cesium.Cartesian3(2500, 0, 3800), gold); // antenna
  }

  private add(dimensions: Cesium.Cartesian3, offset: Cesium.Cartesian3, color: Cesium.Color): void {
    const geometry = Cesium.BoxGeometry.fromDimensions({ dimensions, vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT });
    const instance = new Cesium.GeometryInstance({
      geometry,
      modelMatrix: Cesium.Matrix4.fromTranslation(offset),
      attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
    });
    const primitive = new Cesium.Primitive({
      geometryInstances: instance,
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true }),
      asynchronous: false,
      show: false,
    });
    this.scene.primitives.add(primitive);
    this.primitives.push(primitive);
  }

  /** positionFixed / velocityFixed in Cesium's Earth-fixed frame (metres, m/s). */
  update(positionFixed: Cesium.Cartesian3, velocityFixed: Cesium.Cartesian3): void {
    const distance = Cesium.Cartesian3.distance(this.scene.camera.positionWC, positionFixed);
    const show = distance < this.visibleWithin;
    for (const p of this.primitives) p.show = show;
    if (!show) return;
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
    for (const p of this.primitives) p.modelMatrix = Cesium.Matrix4.clone(this.matrix, p.modelMatrix);
  }

  hide(): void {
    for (const p of this.primitives) p.show = false;
  }

  destroy(): void {
    for (const p of this.primitives) this.scene.primitives.remove(p);
    this.primitives.length = 0;
  }
}
