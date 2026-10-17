import { useEffect, useMemo, useRef } from 'react';
import { ExplorerScene, type SceneApproach } from './ExplorerScene';
import { MAX_PATHS } from './filters';
import { STRIDE, altitudeKm, speedKms, subpoint } from './propagation';
import type { OrbitItem, WorkerIn, WorkerOut } from './propagator.worker';
import { approachKey, selectActiveApproach, useExplorerStore } from './store';

const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });

// The magenta line draws itself in once on load; an approach's orbits draw in faster.
const FIRST_REVEAL_S = 1.2;
const APPROACH_REVEAL_S = 0.6;

/**
 * Hosts the Cesium viewer and the SGP4 worker. The scene (plain TypeScript) owns every
 * primitive; React effects push store changes into it, as GlobeView does on the mission page.
 */
export default function GlobeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ExplorerScene | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const orbitRequest = useRef(0);
  const routeRequest = useRef(0);
  const routeMeta = useRef<{ approach: SceneApproach | null; revealS: number; fly: boolean }>({ approach: null, revealS: 0, fly: false });
  const routeDrawn = useRef(false);
  const objects = useExplorerStore((s) => s.objects);
  const mask = useExplorerStore((s) => s.mask);
  const visible = useExplorerStore((s) => s.visible);
  const selected = useExplorerStore((s) => s.selected);
  const showPaths = useExplorerStore((s) => s.showPaths);
  const focusRequest = useExplorerStore((s) => s.focusRequest);
  const modelIndex = useExplorerStore((s) => s.modelIndex);
  const active = useExplorerStore(selectActiveApproach);
  const pinned = useExplorerStore((s) => s.pinnedApproach);
  const indexByNorad = useMemo(() => new Map(objects.map((o, i) => [o.norad_id, i])), [objects]);

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
      // Cesium leaves its own error panel in the container; the page explains the failure itself.
      containerRef.current.replaceChildren();
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
        if (!store.propagated) store.setPropagated(true);
        if (msg.failed !== lastFailed) {
          lastFailed = msg.failed;
          const failed = new Uint8Array(objects.length);
          for (let i = 0; i < objects.length; i++) failed[i] = Number.isFinite(msg.buffer[i * STRIDE]) ? 0 : 1;
          store.setFailed(failed);
        }
        const m = store.modelIndex;
        if (m !== null && Number.isFinite(msg.buffer[m * STRIDE])) {
          const o = m * STRIDE;
          store.setModelLive({ altitudeKm: altitudeKm(msg.buffer, o), speedKms: speedKms(msg.buffer, o), ...subpoint(msg.buffer, o, msg.unix) });
        }
        const sel = store.selected;
        if (sel !== null && Number.isFinite(msg.buffer[sel * STRIDE])) {
          store.setLive({ altitudeKm: altitudeKm(msg.buffer, sel * STRIDE), speedKms: speedKms(msg.buffer, sel * STRIDE) });
        }
      } else if (msg.type === 'orbits' && msg.requestId === orbitRequest.current) {
        scene.setPaths(msg.paths);
      } else if (msg.type === 'route' && msg.requestId === routeRequest.current) {
        const { approach, revealS, fly } = routeMeta.current;
        scene.setRoute(msg.paths, approach, revealS);
        if (fly) scene.focusApproach();
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

  // GPM's orbit, the magenta line; with an approach shown, both orbits centred on the time of closest
  // approach so they cross at the marker. A pinned (clicked) approach also turns the camera to it.
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker || modelIndex === null || !objects[modelIndex]) return;
    const secondary = active ? (indexByNorad.get(active.norad_id) ?? null) : null;
    const startFor = (periodMin: number) => (active ? active.tca_unix - periodMin * 30 : undefined);
    const items: OrbitItem[] = [{ index: modelIndex, periodMin: objects[modelIndex].period_min, startUnix: startFor(objects[modelIndex].period_min) }];
    if (secondary !== null) items.push({ index: secondary, periodMin: objects[secondary].period_min, startUnix: startFor(objects[secondary].period_min) });
    routeMeta.current = {
      approach:
        active && secondary !== null
          ? { index: secondary, tcaTemeKm: active.primary_position_teme_km, label: `${active.miss_distance_km.toFixed(2)} km at ${timeFormat.format(active.tca_unix * 1000)} UTC` }
          : null,
      revealS: routeDrawn.current ? (active ? APPROACH_REVEAL_S : 0) : FIRST_REVEAL_S,
      fly: active !== null && pinned === approachKey(active),
    };
    routeDrawn.current = true;
    const msg: WorkerIn = { type: 'route', requestId: ++routeRequest.current, items };
    worker.postMessage(msg);
  }, [objects, modelIndex, active, pinned, indexByNorad]);

  // The enclosing section names the globe; the canvas itself is driven by mouse and by the rail.
  return <div ref={containerRef} className="absolute inset-0" />;
}
