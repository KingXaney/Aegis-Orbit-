import { geoEquirectangular, geoGraticule10, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import landUrl from 'world-atlas/land-50m.json?url';

// A flat, vector-drawn Earth: dark ocean, a slightly lighter land fill, thin coastlines and a faint
// 10° graticule, rasterised once into an equirectangular texture. Clean at every zoom the explorer
// uses, and dark enough that the coloured objects carry the picture.

export const EARTH_COLORS = {
  ocean: '#060f1f',
  land: '#18294a',
  coast: '#3a5583',
  graticule: 'rgba(120, 150, 200, 0.07)',
};

/** Draws the texture and returns an object URL for it (an equirectangular image, 2:1). */
export async function buildEarthTexture(width = 8192): Promise<string> {
  const height = width / 2;
  const topo = (await (await fetch(landUrl)).json()) as Topology<{ land: GeometryCollection }>;
  const land = feature(topo, topo.objects.land);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const projection = geoEquirectangular()
    .scale(width / (2 * Math.PI))
    .translate([width / 2, height / 2]);
  const path = geoPath(projection, ctx);
  const px = width / 4096; // line widths are tuned at 4096 px

  ctx.fillStyle = EARTH_COLORS.ocean;
  ctx.fillRect(0, 0, width, height);

  ctx.beginPath();
  path(geoGraticule10());
  ctx.strokeStyle = EARTH_COLORS.graticule;
  ctx.lineWidth = 1 * px;
  ctx.stroke();

  ctx.beginPath();
  path(land);
  ctx.fillStyle = EARTH_COLORS.land;
  ctx.fill();
  ctx.strokeStyle = EARTH_COLORS.coast;
  ctx.lineWidth = 1.2 * px;
  ctx.lineJoin = 'round';
  ctx.stroke();

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the Earth texture'))), 'image/png'),
  );
  return URL.createObjectURL(blob);
}
