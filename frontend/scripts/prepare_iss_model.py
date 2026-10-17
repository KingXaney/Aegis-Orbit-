"""Prepare NASA's ISS (B) glTF model for the globe: public/models/iss.glb.

Source (NASA 3D Resources, credit NASA/Michael D. Carbajal):
https://science.nasa.gov/3d-resources/international-space-station-iss-b/
https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/model/international-space-station-(iss)-(b)/International%20Space%20Station%20(ISS)%20(B).glb

The original has seven stray cylinders floating ~40 units above the station, a flat grey
material everywhere and arbitrary units/axes. This script:

1. drops the stray nodes (they are not ISS hardware);
2. gives the materials ISS colours (copper-gold array blankets, white modules and radiators,
   grey truss);
3. bakes a root transform so the model is in metres, centred on its bounding box, in the body
   frame the globe uses: x along velocity, y cross-track, z radial (zenith). In the source,
   +y runs aft to forward (Russian segment to Node 2), the truss lies along z and sits on the
   -x side of Destiny, so -x is zenith. The scale makes the truss span the published 109 m.

The geometry (Draco-compressed) is copied byte for byte. Usage:
    python prepare_iss_model.py <downloaded.glb> <out.glb>
"""
import json
import struct
import sys

PUBLISHED_TRUSS_SPAN_M = 109.0

# name prefix -> (base colour RGBA, metallic, roughness)
MATERIALS = {
    'lambert7SG': ([0.42, 0.25, 0.07, 1.0], 0.35, 0.35),  # solar array blankets
    'anisotropic1SG': ([0.62, 0.63, 0.66, 1.0], 0.7, 0.45),  # integrated truss
    'lambert3SG': ([0.55, 0.56, 0.6, 1.0], 0.6, 0.5),  # truss hardware
    'soyuz_blinn4SG': ([0.85, 0.85, 0.84, 1.0], 0.1, 0.6),  # radiators
    'apollohorns': ([0.93, 0.93, 0.92, 1.0], 0.05, 0.7),  # radiators
}
DEFAULT_MATERIAL = ([0.86, 0.85, 0.81, 1.0], 0.15, 0.65)  # pressurized modules (white MLI)


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


def main(src, dst):
    gltf, rest = read_glb(src)
    root = next(n for n in gltf['nodes'] if n.get('name') == 'isscombine')
    if any(k in root for k in ('matrix', 'translation', 'rotation', 'scale')):
        raise SystemExit('unexpected transform on the root node; re-check the axis mapping')
    root['children'] = [c for c in root['children'] if gltf['nodes'][c].get('name', '').startswith('polySurfa')]

    # bounding box of the remaining meshes (their nodes carry no transforms)
    lo, hi = [float('inf')] * 3, [float('-inf')] * 3
    for c in root['children']:
        node = gltf['nodes'][c]
        if any(k in node for k in ('matrix', 'translation', 'rotation', 'scale')):
            raise SystemExit(f"unexpected transform on node {node.get('name')}")
        for prim in gltf['meshes'][node['mesh']]['primitives']:
            acc = gltf['accessors'][prim['attributes']['POSITION']]
            lo = [min(a, b) for a, b in zip(lo, acc['min'])]
            hi = [max(a, b) for a, b in zip(hi, acc['max'])]
    cx, cy, cz = [(a + b) / 2 for a, b in zip(lo, hi)]
    s = PUBLISHED_TRUSS_SPAN_M / (hi[2] - lo[2])
    # body = M (model - centre): x_b = s*y_m, y_b = -s*z_m, z_b = -s*x_m (column-major below)
    root['matrix'] = [
        0, 0, -s, 0,
        s, 0, 0, 0,
        0, -s, 0, 0,
        -s * cy, s * cz, s * cx, 1,
    ]

    for m in gltf['materials']:
        rgba, metallic, roughness = next((v for k, v in MATERIALS.items() if m['name'].startswith(k)), DEFAULT_MATERIAL)
        m.setdefault('pbrMetallicRoughness', {}).update(
            baseColorFactor=rgba, metallicFactor=metallic, roughnessFactor=roughness)
        m['doubleSided'] = True  # array blankets are single planes

    gltf.setdefault('asset', {})['copyright'] = 'NASA/Michael D. Carbajal (NASA 3D Resources)'
    size = write_glb(dst, gltf, rest)
    ext = [(b - a) * s for a, b in zip(lo, hi)]
    print(f'wrote {dst} ({size} bytes); envelope in-track {ext[1]:.1f} m, cross-track {ext[2]:.1f} m, radial {ext[0]:.1f} m')


if __name__ == '__main__':
    main(*sys.argv[1:3])
