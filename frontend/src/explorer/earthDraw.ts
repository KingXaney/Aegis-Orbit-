import { geoEquirectangular, geoGraticule10, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import landUrl from 'world-atlas/land-50m.json?url';

// A flat, vector-drawn Earth: dark ocean, a lighter slate land fill, thin coastlines and a faint
// 10° graticule, as an equirectangular (2:1) image. Land reads clearly against the ocean but stays
// dark enough that the objects carry the picture. Shared by the texture worker and its fallback.

export interface EarthColors {
  ocean: string;
  land: string;
  coast: string;
}

const GRATICULE = 'rgba(154, 163, 175, 0.08)';

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export async function drawEarth(ctx: Context2D, width: number, colors: EarthColors): Promise<void> {
  const height = width / 2;
  const topo = (await (await fetch(landUrl)).json()) as Topology<{ land: GeometryCollection }>;
  const land = feature(topo, topo.objects.land);
  const projection = geoEquirectangular()
    .scale(width / (2 * Math.PI))
    .translate([width / 2, height / 2]);
  const path = geoPath(projection, ctx as CanvasRenderingContext2D);
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
}
