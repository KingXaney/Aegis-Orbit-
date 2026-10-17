import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { SpacecraftDesign } from '../types/api';
import { MODEL_ASSETS, PART_COLORS, designParts, type Axis, type Part } from '../globe/designs';
import { disposeObject, makeSpacecraft } from './geometry';

/**
 * The spacecraft the globe's Close-up shows, rendered with Three.js for the encounter view:
 * NASA's glTF for the designs that have one (ISS, GPM) and the part list from designs.ts for every
 * other design, which also stands in while a glTF loads. Both are in the body frame the globe uses
 * (metres: x along velocity, y cross-track, z radial); `bodyToWorldMatrix` turns that into the
 * encounter view's world axes (x = -N, y = +R, z = -T), and the whole model is scaled uniformly so
 * its largest envelope dimension spans a chosen number of world units (the view's enlargement).
 */

export type SpacecraftModelKind = 'schematic' | 'parts' | 'gltf';

/** Rotation from the body frame (x in-track, y cross-track, z radial) to the encounter world frame. */
export function bodyToWorldMatrix(): THREE.Matrix4 {
  // columns: where body x, y and z point in world coordinates (a proper rotation, determinant +1)
  return new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0));
}

/** Uniform scale (world units per metre) that fits the design's largest envelope dimension into `span`. */
export function fitScale(design: SpacecraftDesign, span: number): number {
  return span / Math.max(design.length_m, design.width_m, design.height_m, 1e-6);
}

/** How many times larger than life the model is drawn when `span` is in kilometres. */
export function enlargementFactor(design: SpacecraftDesign, spanKm: number): number {
  return (spanKm * 1000) / Math.max(design.length_m, design.width_m, design.height_m, 1e-6);
}

export function designKey(design: SpacecraftDesign | null): string {
  return design ? `${design.design_id}:${design.length_m}:${design.width_m}:${design.height_m}` : '';
}

// Three's cylinders run along +y; rotate so +y becomes the part's axis (radiusPos stays at the +axis end).
const CYLINDER_ROTATION: Record<Axis, THREE.Euler> = {
  x: new THREE.Euler(0, 0, -Math.PI / 2),
  y: new THREE.Euler(0, 0, 0),
  z: new THREE.Euler(Math.PI / 2, 0, 0),
};

export function partMesh(part: Part, material: THREE.Material): THREE.Mesh {
  const geometry = part.kind === 'box'
    ? new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2])
    : new THREE.CylinderGeometry(part.radiusPos, part.radiusNeg, part.length, 24);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(part.center[0], part.center[1], part.center[2]);
  if (part.kind === 'cylinder') mesh.rotation.copy(CYLINDER_ROTATION[part.axis]);
  return mesh;
}

function ghostMaterial(): THREE.Material {
  return new THREE.MeshBasicMaterial({ color: '#2dd4bf', transparent: true, opacity: 0.3, depthWrite: false });
}

function partMaterial(css: string): THREE.Material {
  const color = new THREE.Color(css);
  // a little self-illumination so the model reads against the dark road without blowing out the lit faces
  return new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.15, emissive: color.clone().multiplyScalar(0.18) });
}

/** The design's part list as lit meshes in the body frame (metres). */
export function buildPartsModel(design: SpacecraftDesign, ghost = false): THREE.Group {
  const group = new THREE.Group();
  const materials = new Map<string, THREE.Material>();
  for (const part of designParts(design)) {
    const key = ghost ? 'ghost' : part.color;
    let material = materials.get(key);
    if (!material) {
      material = ghost ? ghostMaterial() : partMaterial(PART_COLORS[part.color]);
      materials.set(key, material);
    }
    group.add(partMesh(part, material));
  }
  return group;
}

let loader: GLTFLoader | null = null;
const gltfScenes = new Map<string, Promise<THREE.Group>>();

function gltfLoader(): GLTFLoader {
  if (!loader) {
    // the NASA assets are Draco-compressed; the decoder is copied next to the Cesium assets by scripts/copy-cesium.mjs
    const draco = new DRACOLoader();
    draco.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
  }
  return loader;
}

/**
 * The design's glTF (if it has one) as a fresh clone scaled to the design's published width, in
 * the body frame. Geometry and materials are shared with every other clone and never disposed.
 */
export function loadDesignGltf(design: SpacecraftDesign): Promise<THREE.Group> | null {
  const asset = MODEL_ASSETS[design.design_id];
  if (!asset) return null;
  let scene = gltfScenes.get(asset.url);
  if (!scene) {
    scene = gltfLoader().loadAsync(asset.url).then((gltf) => {
      gltf.scene.traverse((o) => {
        o.userData.sharedAsset = true; // disposeObject() leaves these alone
      });
      return gltf.scene;
    });
    gltfScenes.set(asset.url, scene);
  }
  return scene.then((root) => {
    const clone = root.clone(true);
    clone.scale.setScalar(design.width_m / asset.nativeWidthM);
    return clone;
  });
}

function ghostify(model: THREE.Object3D): void {
  const material = ghostMaterial();
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) mesh.material = material;
  });
}

/**
 * One spacecraft drawing in the scene (the map or chase spacecraft, or its ghost). `group` is what
 * the scene positions; the model inside it is rebuilt whenever the design changes.
 */
export class SpacecraftVisual {
  readonly group = new THREE.Group();
  kind: SpacecraftModelKind = 'schematic';
  private readonly frame = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private key = '';
  private generation = 0;
  private disposed = false;

  constructor(private readonly span: number, private readonly options: { ghost?: boolean; halo?: boolean } = {}) {
    this.frame.setRotationFromMatrix(bodyToWorldMatrix());
    this.group.add(this.frame);
    if (options.halo) {
      const halo = new THREE.Mesh(new THREE.CircleGeometry(0.46 * span, 40), new THREE.MeshBasicMaterial({ color: '#67e8f9', transparent: true, opacity: 0.16, depthWrite: false }));
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = -0.1 * span;
      this.group.add(halo);
    }
    this.show(makeSpacecraft(span, !!options.ghost), 'schematic');
  }

  setDesign(design: SpacecraftDesign | null): void {
    const key = designKey(design);
    if (key === this.key) return;
    this.key = key;
    const generation = ++this.generation;
    if (!design) {
      this.frame.scale.setScalar(1);
      this.show(makeSpacecraft(this.span, !!this.options.ghost), 'schematic');
      return;
    }
    this.frame.scale.setScalar(fitScale(design, this.span));
    this.show(buildPartsModel(design, !!this.options.ghost), 'parts');
    loadDesignGltf(design)
      ?.then((gltf) => {
        if (generation !== this.generation || this.disposed) return;
        if (this.options.ghost) ghostify(gltf);
        this.show(gltf, 'gltf');
      })
      .catch((err: unknown) => console.warn(`spacecraft model for ${design.design_id} failed to load; keeping the part-based model`, err));
  }

  private show(model: THREE.Object3D | null, kind: SpacecraftModelKind): void {
    if (this.model) {
      const old = this.model;
      (old.userData.sharedAsset ? this.frame : this.group).remove(old);
      disposeObject(old);
    }
    this.model = model;
    this.kind = kind;
    if (!model) return;
    // the schematic is already in world axes; designs are in the body frame
    (kind === 'schematic' ? this.group : this.frame).add(model);
  }

  dispose(): void {
    this.disposed = true;
    this.show(null, 'schematic');
    this.group.removeFromParent();
    disposeObject(this.group);
  }
}
