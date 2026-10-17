import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const boxCache = new Map<string, RoundedBoxGeometry>();

export function roundedBox(w: number, h: number, d: number): RoundedBoxGeometry {
  const key = `${w}|${h}|${d}`;
  let g = boxCache.get(key);
  if (!g) {
    g = new RoundedBoxGeometry(w, h, d, 3, Math.min(w, h, d) * 0.18);
    boxCache.set(key, g);
  }
  return g;
}

export interface Ribbon {
  group: THREE.Group;
  update: (centers: Float32Array, halfWidth: number, y: number) => void; // centers: x,y,z per vertex row (y ignored)
  setOpacity: (o: number) => void;
  setColors: (near: string, far: string) => void;
}

/** A flat strip with a soft additive glow twin. `n` rows of two vertices each. */
export function makeRibbon(n: number, near = '#14b8a6', far = '#5eead4', opacity = 0.72): Ribbon {
  const makeStrip = (widthScale: number, mat: THREE.Material) => {
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(n * 2 * 3);
    const colors = new Float32Array(n * 2 * 3);
    const index: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.setIndex(index);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false;
    mesh.userData.widthScale = widthScale;
    return mesh;
  };
  const main = makeStrip(1, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
  const glow = makeStrip(1.9, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: opacity * 0.2, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  const group = new THREE.Group();
  group.add(glow, main);
  const cNear = new THREE.Color(near);
  const cFar = new THREE.Color(far);
  const applyColors = (mesh: THREE.Mesh) => {
    const col = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const tmp = new THREE.Color();
    for (let i = 0; i < n; i++) {
      tmp.copy(cNear).lerp(cFar, i / (n - 1));
      col.setXYZ(i * 2, tmp.r, tmp.g, tmp.b);
      col.setXYZ(i * 2 + 1, tmp.r, tmp.g, tmp.b);
    }
    col.needsUpdate = true;
  };
  applyColors(main);
  applyColors(glow);
  return {
    group,
    update: (centers, halfWidth, y) => {
      for (const mesh of [main, glow]) {
        const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
        const hw = halfWidth * (mesh.userData.widthScale as number);
        for (let i = 0; i < n; i++) {
          const x = centers[i * 3];
          const z = centers[i * 3 + 2];
          const yy = y + centers[i * 3 + 1];
          pos.setXYZ(i * 2, x - hw, yy, z);
          pos.setXYZ(i * 2 + 1, x + hw, yy, z);
        }
        pos.needsUpdate = true;
        mesh.geometry.computeBoundingSphere();
      }
    },
    setOpacity: (o) => {
      (main.material as THREE.MeshBasicMaterial).opacity = o;
      (glow.material as THREE.MeshBasicMaterial).opacity = o * 0.2;
    },
    setColors: (a, b) => {
      cNear.set(a);
      cFar.set(b);
      applyColors(main);
      applyColors(glow);
    },
  };
}

export function makeDashedLine(color: string, opacity = 0.6, dash = 0.8, gap = 0.5): THREE.Line {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2 * 3), 3));
  const line = new THREE.Line(geom, new THREE.LineDashedMaterial({ color, dashSize: dash, gapSize: gap, transparent: true, opacity, depthWrite: false }));
  line.frustumCulled = false;
  return line;
}

export function setLinePoints(line: THREE.Line, points: THREE.Vector3[] | Float32Array): void {
  const flat = points instanceof Float32Array ? points : Float32Array.from(points.flatMap((p) => [p.x, p.y, p.z]));
  const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!attr || attr.count !== flat.length / 3) {
    line.geometry.setAttribute('position', new THREE.BufferAttribute(flat, 3));
  } else {
    (attr.array as Float32Array).set(flat);
    attr.needsUpdate = true;
  }
  line.geometry.computeBoundingSphere();
  if (line.material instanceof THREE.LineDashedMaterial) line.computeLineDistances();
}

export function makeLine(points: THREE.Vector3[], color: string, opacity = 0.4, dashed = false): THREE.Line {
  const geom = new THREE.BufferGeometry().setFromPoints(points);
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.8, gapSize: 0.5, depthWrite: false })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const line = new THREE.Line(geom, mat);
  if (dashed) line.computeLineDistances();
  return line;
}

/** Procedural spacecraft in world axes (x across the road, y up, z along the road, forward = -z). */
export function makeSpacecraft(spanUnits: number, ghost = false): THREE.Group {
  const s = spanUnits / 35;
  const g = new THREE.Group();
  const busMat = ghost
    ? new THREE.MeshBasicMaterial({ color: '#2dd4bf', transparent: true, opacity: 0.35, depthWrite: false })
    : new THREE.MeshLambertMaterial({ color: '#f1f5f9', emissive: '#334155', emissiveIntensity: 0.6 });
  const panelMat = ghost
    ? new THREE.MeshBasicMaterial({ color: '#2dd4bf', transparent: true, opacity: 0.25, depthWrite: false })
    : new THREE.MeshLambertMaterial({ color: '#3b82f6', emissive: '#1d4ed8', emissiveIntensity: 0.5 });
  const goldMat = ghost ? busMat : new THREE.MeshLambertMaterial({ color: '#f5c86b', emissive: '#92400e', emissiveIntensity: 0.3 });
  const bus = new THREE.Mesh(new THREE.BoxGeometry(8 * s, 6 * s, 13 * s), busMat);
  const panelGeom = new THREE.BoxGeometry(14 * s, 0.4 * s, 5 * s);
  const left = new THREE.Mesh(panelGeom, panelMat);
  left.position.x = -10.5 * s;
  const right = new THREE.Mesh(panelGeom, panelMat);
  right.position.x = 10.5 * s;
  const boom = new THREE.Mesh(new THREE.BoxGeometry(7 * s, 0.8 * s, 0.8 * s), goldMat);
  const antenna = new THREE.Mesh(new THREE.BoxGeometry(2.6 * s, 3.6 * s, 2.6 * s), goldMat);
  antenna.position.set(0, 4.5 * s, -3.5 * s);
  g.add(bus, left, right, boom, antenna);
  if (!ghost) {
    const halo = new THREE.Mesh(new THREE.CircleGeometry(16 * s, 40), new THREE.MeshBasicMaterial({ color: '#67e8f9', transparent: true, opacity: 0.16, depthWrite: false }));
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -3.5 * s;
    g.add(halo);
  }
  if (!ghost) {
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(panelGeom), new THREE.LineBasicMaterial({ color: '#93c5fd', transparent: true, opacity: 0.8 }));
    edges.position.x = -10.5 * s;
    const edges2 = edges.clone();
    edges2.position.x = 10.5 * s;
    g.add(edges, edges2);
  }
  return g;
}

export function makeDisc(radius: number, color: string, opacity: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CircleGeometry(radius, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2;
  return m;
}

export function makeRing(radius: number, thickness: number, color: string, opacity: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.RingGeometry(radius - thickness / 2, radius + thickness / 2, 96), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2;
  return m;
}

export function makePoints(count: number, color: string, size: number): THREE.Points {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  const mat = new THREE.PointsMaterial({ color, size, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  const pts = new THREE.Points(geom, mat);
  pts.frustumCulled = false;
  return pts;
}

export function setPoints(points: THREE.Points, flat: Float32Array, fadeCenter = true): void {
  const attr = points.geometry.getAttribute('position') as THREE.BufferAttribute;
  const col = points.geometry.getAttribute('color') as THREE.BufferAttribute;
  const n = flat.length / 3;
  if (attr.count !== n) {
    points.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flat), 3));
    points.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  } else {
    (attr.array as Float32Array).set(flat);
    attr.needsUpdate = true;
  }
  const c = points.geometry.getAttribute('color') as THREE.BufferAttribute;
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? Math.abs(i / (n - 1) - 0.5) * 2 : 0;
    const b = fadeCenter ? 1 - 0.75 * t : 1;
    c.setXYZ(i, b, b, b);
  }
  c.needsUpdate = true;
  void col;
  points.geometry.setDrawRange(0, n);
  points.geometry.computeBoundingSphere();
}

export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    if (o.userData.sharedAsset) return; // glTF geometry/materials shared by every clone (see spacecraftModel.ts)
    const mesh = o as THREE.Mesh;
    if (mesh.geometry && !(mesh.geometry instanceof RoundedBoxGeometry)) mesh.geometry.dispose();
    const mat = (mesh as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
}
