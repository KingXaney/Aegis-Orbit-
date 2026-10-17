"""Prepare NASA 3D Resources glTF models for the globe (public/models/*.glb).

Each model is rewritten so it is in metres, in the body frame the globe uses: x along velocity,
y cross-track, z radial (zenith). The mesh data (Draco-compressed) is copied byte for byte; only
the scene graph and materials change.

    python prepare_models.py iss <downloaded.glb> <out.glb>
    python prepare_models.py gpm <downloaded.glb> <out.glb>

iss: "International Space Station (ISS) (B)", credit NASA/Michael D. Carbajal
    https://science.nasa.gov/3d-resources/international-space-station-iss-b/
    The original has seven stray cylinders floating above the station and a flat grey material
    everywhere. Stray nodes are dropped and the materials get ISS colours. In the source, +y runs
    aft to forward (Russian segment to Node 2), the truss lies along z and sits on the -x side of
    Destiny (so -x is zenith). Scaled so the truss spans the published 109 m.

gpm: "Global Precipitation Measurement", credit NASA/Christopher R. Meaney
    https://science.nasa.gov/3d-resources/global-precipitation-measurement/
    Materials are kept. In the source, +y is zenith (GMI dish on top, DPR radar below), the GMI
    sits toward +x and scans forward along the velocity (so +x is forward) and the solar wings
    extend along z. The wings are posed as in NASA's artwork: one flat, one tilted (they track the
    sun independently). Scaled so the longest extent, wing tip to wing tip, is the published 13 m;
    that gives ~38 m^2 of panels for the published 26.5 m^2 of cells, while scaling to the
    published 5 m height would leave less panel area than cell area. Centred on the bus.
"""
import json
import struct
import sys

TRANSFORM_KEYS = ('matrix', 'translation', 'rotation', 'scale')

ISS_MATERIALS = {  # name prefix -> (base colour RGBA, metallic, roughness)
    'lambert7SG': ([0.42, 0.25, 0.07, 1.0], 0.35, 0.35),  # solar array blankets
    'anisotropic1SG': ([0.62, 0.63, 0.66, 1.0], 0.7, 0.45),  # integrated truss
    'lambert3SG': ([0.55, 0.56, 0.6, 1.0], 0.6, 0.5),  # truss hardware
    'soyuz_blinn4SG': ([0.85, 0.85, 0.84, 1.0], 0.1, 0.6),  # radiators
    'apollohorns': ([0.93, 0.93, 0.92, 1.0], 0.05, 0.7),  # radiators
}
ISS_DEFAULT_MATERIAL = ([0.86, 0.85, 0.81, 1.0], 0.15, 0.65)  # pressurized modules (white MLI)


def read_glb(path):
    data = open(path, 'rb').read()
    magic, version, _ = struct.unpack('<4sII', data[:12])
    if magic != b'glTF' or version != 2:
        raise SystemExit(f'{path}: not a glTF 2.0 binary')
    json_len, json_type = struct.unpack('<I4s', data[12:20])
    if json_type != b'JSON':
        raise SystemExit(f'{path}: first chunk is not JSON')
    return json.loads(data[20:20 + json_len]), data[20 + json_len:]


def write_glb(path, gltf, rest):
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    total = 12 + 8 + len(js) + len(rest)
    with open(path, 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, total) + struct.pack('<I4s', len(js), b'JSON') + js + rest)
    return total


def mesh_bounds(gltf, node_ids):
    """Bounds of the meshes on these nodes, which must carry no transforms of their own."""
    lo, hi = [float('inf')] * 3, [float('-inf')] * 3
    for i in node_ids:
        node = gltf['nodes'][i]
        if any(k in node for k in TRANSFORM_KEYS):
            raise SystemExit(f"unexpected transform on node {node.get('name')}; re-check the axis mapping")
        for prim in gltf['meshes'][node['mesh']]['primitives']:
            acc = gltf['accessors'][prim['attributes']['POSITION']]
            lo = [min(a, b) for a, b in zip(lo, acc['min'])]
            hi = [max(a, b) for a, b in zip(hi, acc['max'])]
    return lo, hi


def body_matrix(rows, s, centre):
    """Column-major glTF matrix for body = s * R (model - centre); rows[i] gives body axis i as
    (model axis index, sign)."""
    r = [[0.0] * 3 for _ in range(3)]
    for b, (m, sign) in enumerate(rows):
        r[b][m] = sign * s
    t = [-sum(r[b][k] * centre[k] for k in range(3)) for b in range(3)]
    return [r[0][0], r[1][0], r[2][0], 0, r[0][1], r[1][1], r[2][1], 0, r[0][2], r[1][2], r[2][2], 0, t[0], t[1], t[2], 1]


def prepare_iss(gltf):
    root = next(n for n in gltf['nodes'] if n.get('name') == 'isscombine')
    if any(k in root for k in TRANSFORM_KEYS):
        raise SystemExit('unexpected transform on the root node; re-check the axis mapping')
    root['children'] = [c for c in root['children'] if gltf['nodes'][c].get('name', '').startswith('polySurfa')]
    lo, hi = mesh_bounds(gltf, root['children'])
    centre = [(a + b) / 2 for a, b in zip(lo, hi)]
    s = 109.0 / (hi[2] - lo[2])
    # x_b = +y_m, y_b = -z_m, z_b = -x_m
    root['matrix'] = body_matrix([(1, 1), (2, -1), (0, -1)], s, centre)
    for m in gltf['materials']:
        rgba, metallic, roughness = next((v for k, v in ISS_MATERIALS.items() if m['name'].startswith(k)), ISS_DEFAULT_MATERIAL)
        m.setdefault('pbrMetallicRoughness', {}).update(baseColorFactor=rgba, metallicFactor=metallic, roughnessFactor=roughness)
        m['doubleSided'] = True  # array blankets are single planes
    gltf.setdefault('asset', {})['copyright'] = 'NASA/Michael D. Carbajal (NASA 3D Resources)'
    return [(b - a) * s for a, b in zip(lo, hi)], [1, 2, 0]


def prepare_gpm(gltf):
    pivot = next(n for n in gltf['nodes'] if n.get('name') == 'Pivot-GPM-MainBus')
    if set(pivot) - {'name', 'children', 'scale'} or len(set(pivot.get('scale', [1, 1, 1]))) != 1:
        raise SystemExit('unexpected transform on the pivot node; re-check the axis mapping')
    lo, hi = mesh_bounds(gltf, pivot['children'])
    s = 13.0 / max(b - a for a, b in zip(lo, hi))
    # centre on the bus: bounding-box centre in x and y, the wing root plane z = 0
    centre = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, 0.0]
    pivot.pop('scale', None)
    # x_b = +x_m, y_b = -z_m, z_b = +y_m
    pivot['matrix'] = body_matrix([(0, 1), (2, -1), (1, 1)], s, centre)
    gltf.setdefault('asset', {})['copyright'] = 'NASA/Christopher R. Meaney (NASA 3D Resources)'
    return [(b - a) * s for a, b in zip(lo, hi)], [0, 2, 1]


def main(kind, src, dst):
    gltf, rest = read_glb(src)
    ext, (in_track, cross_track, radial) = {'iss': prepare_iss, 'gpm': prepare_gpm}[kind](gltf)
    size = write_glb(dst, gltf, rest)
    print(f'wrote {dst} ({size} bytes); envelope in-track {ext[in_track]:.2f} m, '
          f'cross-track {ext[cross_track]:.2f} m, radial {ext[radial]:.2f} m')


if __name__ == '__main__':
    main(*sys.argv[1:4])
