import { useEffect, useRef } from 'react';
import { ExplorerScene } from './ExplorerScene';
import { MAX_PATHS } from './filters';
import { STRIDE, altitudeKm, speedKms } from './propagation';
import type { WorkerIn, WorkerOut } from './propagator.worker';
import { useExplorerStore } from './store';

/**
 * Hosts the Cesium viewer and the SGP4 worker. The scene (plain TypeScript) owns every
 * primitive; React effects push store changes into it, as GlobeView does on the mission page.
 */
export default function GlobeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ExplorerScene | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const orbitRequest = useRef(0);
  const objects = useExplorerStore((s) => s.objects);
  const mask = useExplorerStore((s) => s.mask);
  const visible = useExplorerStore((s) => s.visible);
  const selected = useExplorerStore((s) => s.selected);
  const showPaths = useExplorerStore((s) => s.showPaths);
  const focusRequest = useExplorerStore((s) => s.focusRequest);

  useEffect(() => {
    if (!containerRef.current || sceneRef.current) return;
    try {
      sceneRef.current = new ExplorerScene(
        containerRef.current,
        { onPick: (index) => useExplorerStore.getState().select(index) },
      );
      if (import.meta.env.DEV) (window as unknown as { __explorer?: ExplorerScene }).__explorer = sceneRef.current;
    } catch (err) {
      console.error('Cesium failed to initialise', err);
      useExplorerStore.getState().setSceneError((err as Error).message);
    }
    return () => {
      sceneRef.current?.destroy();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || objects.length === 0) return;
    scene.setCatalog(objects);
    scene.setMask(useExplorerStore.getState().mask);
    const worker = new Worker(new URL('./propagator.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    let lastFailed = -1;
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data;
      if (msg.type === 'state') {
        scene.setState(msg.buffer, msg.unix);
        const store = useExplorerStore.getState();
        if (msg.failed !== lastFailed) {
          lastFailed = msg.failed;
          const failed = new Uint8Array(objects.length);
          for (let i = 0; i < objects.length; i++) failed[i] = Number.isFinite(msg.buffer[i * STRIDE]) ? 0 : 1;
          store.setFailed(failed);
        }
        const sel = store.selected;
        if (sel !== null && Number.isFinite(msg.buffer[sel * STRIDE])) {
          store.setLive({ altitudeKm: altitudeKm(msg.buffer, sel * STRIDE), speedKms: speedKms(msg.buffer, sel * STRIDE) });
        }
      } else if (msg.type === 'orbits' && msg.requestId === orbitRequest.current) {
        scene.setPaths(msg.paths);
      }
    };
    const init: WorkerIn = { type: 'init', tles: objects.map((o) => [o.tle1, o.tle2]) };
    worker.postMessage(init);
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [objects]);

  useEffect(() => {
    sceneRef.current?.setMask(mask);
  }, [mask]);

  useEffect(() => {
    sceneRef.current?.setSelected(selected);
  }, [selected]);

  // Orbits: the selected object's always; every visible object's when the switch is on and few enough are shown.
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const indices: number[] = [];
    if (showPaths && visible <= MAX_PATHS) {
      for (let i = 0; i < mask.length; i++) if (mask[i] && i !== selected) indices.push(i);
    }
    if (selected !== null) indices.push(selected);
    const requestId = ++orbitRequest.current;
    if (indices.length === 0) {
      sceneRef.current?.setPaths([]);
      return;
    }
    const msg: WorkerIn = { type: 'orbits', requestId, items: indices.map((index) => ({ index, periodMin: objects[index].period_min })) };
    worker.postMessage(msg);
  }, [showPaths, mask, visible, selected, objects]);

  useEffect(() => {
    if (focusRequest) sceneRef.current?.focus(focusRequest.index);
  }, [focusRequest]);

  return <div ref={containerRef} className="absolute inset-0" aria-label="3D globe of tracked objects in orbit" />;
}
