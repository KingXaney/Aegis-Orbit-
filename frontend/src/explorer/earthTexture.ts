import { geoEquirectangular, geoGraticule10, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import landUrl from 'world-atlas/land-50m.json?url';

// A flat, vector-drawn Earth: dark ocean, a lighter slate land fill, thin coastlines and a faint
// 10° graticule, rasterised once into an equirectangular texture. Clean at every zoom the explorer
// uses; land reads clearly against the ocean but stays dark enough that the objects carry the picture.

export interface EarthColors {
  ocean: string;
  land: string;
  coast: string;
}

const GRATICULE = 'rgba(154, 163, 175, 0.08)';

/** Draws the texture and returns an object URL for it (an equirectangular image, 2:1). */
export async function buildEarthTexture(width: number, colors: EarthColors): Promise<string> {
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

  ctx.fillStyle = colors.ocean;
  ctx.fillRect(0, 0, width, height);

  ctx.beginPath();
  path(geoGraticule10());
  ctx.strokeStyle = GRATICULE;
  ctx.lineWidth = 1 * px;
  ctx.stroke();

  ctx.beginPath();
  path(land);
  ctx.fillStyle = colors.land;
  ctx.fill();
  ctx.strokeStyle = colors.coast;
  ctx.lineWidth = 1.2 * px;
  ctx.lineJoin = 'round';
  ctx.stroke();

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the Earth texture'))), 'image/png'),
  );
  return URL.createObjectURL(blob);
}
