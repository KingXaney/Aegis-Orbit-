/// <reference lib="webworker" />
import type { SatRec } from 'satellite.js';
import { STRIDE, orbitPoints, parseSatrecs, propagateAll } from './propagation';

// Propagates the whole catalog once per second and posts TEME states (transferable buffer).
// The main thread extrapolates between ticks, so a second is plenty.

export type WorkerIn =
  | { type: 'init'; tles: [string, string][] }
  | { type: 'orbits'; requestId: number; items: { index: number; periodMin: number }[] };

export type WorkerOut =
  | { type: 'state'; unix: number; failed: number; buffer: Float32Array }
  | { type: 'orbits'; requestId: number; paths: { index: number; points: Float32Array }[] };

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
  } else if (msg.type === 'orbits') {
    const unix = Date.now() / 1000;
    const paths = msg.items
      .filter((it) => satrecs[it.index])
      .map((it) => ({ index: it.index, points: orbitPoints(satrecs[it.index], it.periodMin, unix) }));
    const out: WorkerOut = { type: 'orbits', requestId: msg.requestId, paths };
    (self as DedicatedWorkerGlobalScope).postMessage(out, paths.map((p) => p.points.buffer as ArrayBuffer));
  }
};
