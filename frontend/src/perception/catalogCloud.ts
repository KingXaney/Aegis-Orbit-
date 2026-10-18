import * as Cesium from 'cesium';
import { STRIDE } from '../explorer/propagation';
import { temeToFixedMatrix } from '../globe/frames';
import type { SimulationController } from '../simulation/controller';
import type { CloudWorkerIn, CloudWorkerOut } from './cloud.worker';
import { IDLE, STEP, membershipBits, pointStyle, type ColorRole } from './funnel';
import { usePerceptionStore, type PerceptionState } from './store';

// The whole tracked catalog as a point cloud around the mission globe (real ISS scenario only), styled
// by the ML funnel's progress. Points sit in TEME (metres) under one model matrix per frame (TEME ->
// Earth-fixed at the frame's clock time), the explorer's approach; SGP4 runs in a worker at the
// simulation time and the positions are extrapolated linearly between its answers.

const ROLE_COLORS: Record<ColorRole, Cesium.Color> = {
  tracked: Cesium.Color.fromCssColorString('#93c5fd'), // --color-tracked
  flagged: Cesium.Color.fromCssColorString('#fbbf24'), // --color-warn
  screened: Cesium.Color.fromCssColorString('#67e8f9'), // --color-primary
  confirmed: Cesium.Color.fromCssColorString('#fbbf24'),
  critical: Cesium.Color.fromCssColorString('#f87171'), // --color-threat
};

/** Ask the worker for a fresh state once the simulation clock is this far from the last one. */
const REFRESH_SIM_S = 15;

/** TEME position (metres) of object `i`, `dt` seconds after the state; null where SGP4 failed. */
export function temeAt(state: Float32Array, i: number, dt: number, out: { x: number; y: number; z: number }): typeof out | null {
  const o = i * STRIDE;
  if (!Number.isFinite(state[o])) return null;
  out.x = (state[o] + state[o + 3] * dt) * 1000;
  out.y = (state[o + 1] + state[o + 4] * dt) * 1000;
  out.z = (state[o + 2] + state[o + 5] * dt) * 1000;
  return out;
}

export class CatalogCloud {
  private readonly points: Cesium.PointPrimitiveCollection;
  private dots: Cesium.PointPrimitive[] = [];
  private ids: string[] = [];
  private visible = new Uint8Array(0);
  private worker: Worker | null = null;
  private state: Float32Array | null = null;
  private stateUnix = 0;
  private inFlight = false;
  private requestId = 0;
  private readonly m3 = new Cesium.Matrix3();
  private readonly pos = new Cesium.Cartesian3();
  private readonly color = new Cesium.Color();
  private readonly unsubscribe: () => void;
  private readonly removePreRender: Cesium.Event.RemoveCallback;

  constructor(
    private readonly viewer: Cesium.Viewer,
    private readonly controller: SimulationController,
  ) {
    this.points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT }));
    this.removePreRender = viewer.scene.preRender.addEventListener(() => this.frame());
    this.unsubscribe = usePerceptionStore.subscribe((s, prev) => this.onStore(s, prev));
    this.onStore(usePerceptionStore.getState(), null);
  }

  private onStore(s: PerceptionState, prev: PerceptionState | null): void {
    const rows = s.active ? s.rows : null;
    const rowsChanged = !prev || rows !== (prev.active ? prev.rows : null);
    if (rowsChanged) this.setRows(rows);
    if (rowsChanged || s.step !== prev?.step || s.perception !== prev?.perception || s.renderedIds !== prev?.renderedIds) this.restyle(s);
  }

  private setRows(rows: PerceptionState['rows']): void {
    this.points.removeAll();
    this.dots = [];
    this.ids = [];
    this.visible = new Uint8Array(0);
    this.state = null;
    this.inFlight = false;
    this.worker?.terminate();
    this.worker = null;
    if (!rows || rows.length === 0) return;
    this.ids = rows.map((r) => r[0]);
    this.dots = rows.map(() => this.points.add({ position: new Cesium.Cartesian3(), pixelSize: 2, show: false, disableDepthTestDistance: 0 }));
    this.visible = new Uint8Array(rows.length).fill(1);
    const worker = new Worker(new URL('./cloud.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<CloudWorkerOut>) => {
      if (worker !== this.worker || e.data.requestId !== this.requestId) return;
      this.state = e.data.buffer;
      this.stateUnix = e.data.unix;
      this.inFlight = false;
    };
    worker.onerror = (e: ErrorEvent) => {
      if (worker !== this.worker) return;
      // stop asking (inFlight stays set) and say so in the panel instead of freezing silently
      console.error('catalog cloud worker failed', e.message);
      usePerceptionStore.setState({ cloudError: e.message || 'the SGP4 worker stopped' });
    };
    this.worker = worker;
    const init: CloudWorkerIn = { type: 'init', tles: rows.map((r) => [r[3], r[4]]) };
    worker.postMessage(init);
    this.request(this.controller.currentUnix);
  }

  private request(unix: number): void {
    if (!this.worker) return;
    this.inFlight = true;
    const msg: CloudWorkerIn = { type: 'propagate', requestId: ++this.requestId, unix };
    this.worker.postMessage(msg);
  }

  private restyle(s: PerceptionState): void {
    if (this.dots.length === 0) return;
    const step = s.perception ? s.step : IDLE;
    const bits = membershipBits(this.ids, s.perception?.funnel ?? null);
    const rendered = new Set(s.renderedIds);
    for (let i = 0; i < this.dots.length; i++) {
      const style = pointStyle(bits[i], step, step >= STEP.confirmed && rendered.has(this.ids[i]));
      this.visible[i] = style ? 1 : 0;
      if (!style) continue;
      const b = this.dots[i];
      b.pixelSize = style.size;
      b.color = Cesium.Color.fromAlpha(ROLE_COLORS[style.role], style.alpha, this.color);
    }
  }

  private frame(): void {
    if (this.dots.length === 0) return;
    const now = this.controller.currentUnix;
    if (!this.inFlight && (this.state === null || Math.abs(now - this.stateUnix) > REFRESH_SIM_S)) this.request(now);
    const s = this.state;
    if (!s) return;
    Cesium.Matrix4.fromRotation(temeToFixedMatrix(this.viewer.clock.currentTime, this.m3), this.points.modelMatrix);
    const dt = now - this.stateUnix;
    for (let i = 0; i < this.dots.length; i++) {
      const b = this.dots[i];
      const show = this.visible[i] === 1 && temeAt(s, i, dt, this.pos) !== null;
      if (b.show !== show) b.show = show;
      if (show) b.position = this.pos;
    }
  }

  destroy(): void {
    this.unsubscribe();
    this.removePreRender();
    this.worker?.terminate();
    this.worker = null;
    if (!this.viewer.isDestroyed()) this.viewer.scene.primitives.remove(this.points);
  }
}
