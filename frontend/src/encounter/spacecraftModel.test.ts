import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bodyToWorldMatrix, buildPartsModel, designKey, enlargementFactor, fitScale, partMesh } from './spacecraftModel';
import { designParts } from '../globe/designs';
import type { SpacecraftDesign } from '../types/api';

const gpm: SpacecraftDesign = { design_id: 'gpm', label: 'GPM Core Observatory', length_m: 6.5, width_m: 13, height_m: 5, basis: 'PUBLISHED_SPEC', reference: '' };

describe('spacecraft model for the encounter view', () => {
  it('maps the body frame onto the encounter world axes with a proper rotation', () => {
    const m = bodyToWorldMatrix();
    const to = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(m).toArray().map((v) => Math.round(v * 1e9) / 1e9 + 0);
    expect(to(1, 0, 0)).toEqual([0, 0, -1]); // in-track -> forward (up the road)
    expect(to(0, 1, 0)).toEqual([-1, 0, 0]); // cross-track -> left
    expect(to(0, 0, 1)).toEqual([0, 1, 0]); // radial -> up
    expect(m.determinant()).toBeCloseTo(1, 12);
  });

  it('fits the largest envelope dimension into the requested span', () => {
    expect(fitScale(gpm, 1.35)).toBeCloseTo(1.35 / 13, 12);
    expect(enlargementFactor(gpm, 0.35)).toBeCloseTo(350 / 13, 9); // about 27x life size in the chase cam
    expect(designKey(gpm)).toBe('gpm:6.5:13:5');
    expect(designKey(null)).toBe('');
  });

  it('builds one mesh per part at the part centre, cylinders along their axis', () => {
    const parts = designParts(gpm);
    const model = buildPartsModel(gpm);
    expect(model.children).toHaveLength(parts.length);
    const cylinder = parts.find((p) => p.kind === 'cylinder' && p.axis === 'x');
    expect(cylinder).toBeDefined();
    const mesh = partMesh(cylinder!, new THREE.MeshBasicMaterial());
    expect(mesh.position.toArray()).toEqual(cylinder!.center);
    // Three's cylinder runs along +y; after the part rotation it must run along the part axis
    const along = new THREE.Vector3(0, 1, 0).applyEuler(mesh.rotation);
    expect(Math.abs(along.x)).toBeCloseTo(1, 9);
  });

  it('shares materials between parts of the same colour', () => {
    const model = buildPartsModel(gpm);
    const materials = new Set(model.children.map((c) => (c as THREE.Mesh).material));
    const colours = new Set(designParts(gpm).map((p) => p.color));
    expect(materials.size).toBe(colours.size);
  });
});
