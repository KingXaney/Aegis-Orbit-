/// <reference lib="webworker" />
import type { SatRec } from 'satellite.js';
import { STRIDE, parseSatrecs, propagateAll } from '../explorer/propagation';

// SGP4 for the mission page's catalog cloud. Unlike the explorer's worker (wall-clock ticks), this one
// propagates on request at the simulation time the globe asks for; the main thread extrapolates
// linearly between answers. States are TEME, km and km/s, STRIDE floats per object; NaN where SGP4 fails.

export type CloudWorkerIn = { type: 'init'; tles: [string, string][] } | { type: 'propagate'; requestId: number; unix: number };
export type CloudWorkerOut = { type: 'state'; requestId: number; unix: number; failed: number; buffer: Float32Array };

let satrecs: SatRec[] = [];

self.onmessage = (e: MessageEvent<CloudWorkerIn>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    satrecs = parseSatrecs(msg.tles);
    return;
  }
  const buffer = new Float32Array(satrecs.length * STRIDE);
  const failed = propagateAll(satrecs, msg.unix, buffer);
  const out: CloudWorkerOut = { type: 'state', requestId: msg.requestId, unix: msg.unix, failed, buffer };
  (self as DedicatedWorkerGlobalScope).postMessage(out, [buffer.buffer]);
};
