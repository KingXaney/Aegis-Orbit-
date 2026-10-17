/// <reference lib="webworker" />
import type { SatRec } from 'satellite.js';
import { STRIDE, orbitPoints, parseSatrecs, propagateAll } from './propagation';

// Propagates the whole catalog once per second and posts TEME states (transferable buffer).
// The main thread extrapolates between ticks, so a second is plenty.

export interface OrbitItem {
  index: number;
  periodMin: number;
  /** First sample time; defaults to now. */
  startUnix?: number;
}

export interface OrbitPath {
  index: number;
  points: Float32Array;
}

// 'orbits' are the filter-driven paths (selection, every shown object); 'route' is GPM's magenta line
// and, while an approach is shown, the other object's orbit, each centred on the time of closest approach.
export type WorkerIn =
  | { type: 'init'; tles: [string, string][] }
  | { type: 'orbits' | 'route'; requestId: number; items: OrbitItem[] };

export type WorkerOut =
  | { type: 'state'; unix: number; failed: number; buffer: Float32Array }
  | { type: 'orbits' | 'route'; requestId: number; paths: OrbitPath[] };

const TICK_MS = 1000;
let satrecs: SatRec[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  const unix = Date.now() / 1000;
  const buffer = new Float32Array(satrecs.length * STRIDE);
  const failed = propagateAll(satrecs, unix, buffer);
  const msg: WorkerOut = { type: 'state', unix, failed, buffer };
  (self as DedicatedWorkerGlobalScope).postMessage(msg, [buffer.buffer]);
}

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    satrecs = parseSatrecs(msg.tles);
    if (timer) clearInterval(timer);
    tick();
    timer = setInterval(tick, TICK_MS);
  } else {
    const unix = Date.now() / 1000;
    const paths = msg.items
      .filter((it) => satrecs[it.index])
      .map((it) => ({ index: it.index, points: orbitPoints(satrecs[it.index], it.periodMin, it.startUnix ?? unix) }));
    const out: WorkerOut = { type: msg.type, requestId: msg.requestId, paths };
    (self as DedicatedWorkerGlobalScope).postMessage(out, paths.map((p) => p.points.buffer as ArrayBuffer));
  }
};
