import { create } from 'zustand';
import { ApiError, api } from '../api/client';
import type { ApproachRecord, ApproachesResponse, CatalogObject, CatalogObjectType, CatalogResponse, OrbitClass } from '../types/api';
import { DEFAULT_FILTERS, MODEL_NORAD_ID, computeMask, ownerCounts, type Filters, type OwnerCount } from './filters';

function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.status === 0 ? e.message : `${e.message} (HTTP ${e.status})`;
  return (e as Error)?.message ?? String(e);
}

/** Identifies an approach across refreshes of the list. */
export function approachKey(a: ApproachRecord): string {
  return `${a.norad_id}@${Math.round(a.tca_unix)}`;
}

export interface ApproachesState {
  /** loading: first request; computing: the backend is still screening (polled); error: no data at all. */
  status: 'loading' | 'computing' | 'ready' | 'error';
  data: ApproachesResponse | null;
  error: string | null;
}

const APPROACHES_REFRESH_MS = 10 * 60 * 1000;
let approachesTimer: ReturnType<typeof setTimeout> | null = null;

/** The selected object is mirrored in the URL (?object=<NORAD ID>) so a view can be shared. */
function writeObjectParam(norad: number | null): void {
  const url = new URL(window.location.href);
  if (norad === null) url.searchParams.delete('object');
  else url.searchParams.set('object', String(norad));
  window.history.replaceState(window.history.state, '', url);
}

function readObjectParam(): number | null {
  const v = Number(new URLSearchParams(window.location.search).get('object'));
  return Number.isInteger(v) && v > 0 ? v : null;
}

export interface LiveState {
  altitudeKm: number;
  speedKms: number;
}

export interface ModelLive extends LiveState {
  latDeg: number;
  lonDeg: number;
}

export interface ExplorerState {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  meta: Omit<CatalogResponse, 'objects'> | null;
  objects: CatalogObject[];
  owners: OwnerCount[];
  filters: Filters;
  failed: Uint8Array;
  mask: Uint8Array;
  visible: number;
  visibleByType: Record<CatalogObjectType, number>;
  showPaths: boolean;
  /** Step everything back except GPM and the objects its screening detected. */
  highlightDetections: boolean;
  panelOpen: boolean;
  selected: number | null;
  live: LiveState | null;
  /** Index of GPM, the model spacecraft, in `objects` (null if the catalog lacks it). */
  modelIndex: number | null;
  modelLive: ModelLive | null;
  /** Set when a selection should also turn the camera toward the object (search results). */
  focusRequest: { index: number; nonce: number } | null;
  sceneError: string | null;
  /** True once the worker has posted its first propagated state for the loaded catalog. */
  propagated: boolean;
  approaches: ApproachesState;
  /** The approach drawn on the globe is the pinned one (clicked), else the previewed one (hovered or focused). */
  pinnedApproach: string | null;
  previewApproach: string | null;

  load: () => Promise<void>;
  loadApproaches: () => Promise<void>;
  setPreviewApproach: (key: string | null) => void;
  togglePinnedApproach: (key: string) => void;
  toggleType: (t: CatalogObjectType) => void;
  toggleClass: (c: OrbitClass) => void;
  toggleOwner: (code: string) => void;
  clearOwners: () => void;
  resetFilters: () => void;
  setShowPaths: (on: boolean) => void;
  setHighlightDetections: (on: boolean) => void;
  setPanelOpen: (open: boolean) => void;
  select: (index: number | null) => void;
  focus: (index: number) => void;
  setFailed: (failed: Uint8Array) => void;
  setLive: (live: LiveState | null) => void;
  setModelLive: (live: ModelLive | null) => void;
  setSceneError: (msg: string) => void;
  setPropagated: (propagated: boolean) => void;
}

/** The approach drawn on the globe: the pinned one, else the previewed one. */
export function selectActiveApproach(s: ExplorerState): ApproachRecord | null {
  const key = s.pinnedApproach ?? s.previewApproach;
  if (!key || !s.approaches.data) return null;
  return s.approaches.data.approaches.find((a) => approachKey(a) === key) ?? null;
}

export const useExplorerStore = create<ExplorerState>((set, get) => {
  const refilter = (filters: Filters, failed = get().failed) => {
    const { mask, visible, byType } = computeMask(get().objects, filters, failed);
    const sel = get().selected;
    const hidesSelection = sel !== null && !mask[sel];
    set({ filters, failed, mask, visible, visibleByType: byType, ...(hidesSelection ? { selected: null, live: null } : {}) });
    if (hidesSelection) writeObjectParam(null);
  };

  return {
    status: 'loading',
    error: null,
    meta: null,
    objects: [],
    owners: [],
    filters: DEFAULT_FILTERS,
    failed: new Uint8Array(0),
    mask: new Uint8Array(0),
    visible: 0,
    visibleByType: { PAYLOAD: 0, DEBRIS: 0, ROCKET_BODY: 0 },
    showPaths: false,
    highlightDetections: true,
    panelOpen: false,
    selected: null,
    live: null,
    modelIndex: null,
    modelLive: null,
    focusRequest: null,
    sceneError: null,
    propagated: false,
    approaches: { status: 'loading', data: null, error: null },
    pinnedApproach: null,
    previewApproach: null,

    load: async () => {
      set({ status: 'loading', error: null, propagated: false });
      try {
        const { objects, ...meta } = await api.catalog();
        const model = objects.findIndex((o) => o.norad_id === MODEL_NORAD_ID);
        set({ objects, meta, owners: ownerCounts(objects), modelIndex: model >= 0 ? model : null, status: 'ready', selected: null });
        refilter(get().filters, new Uint8Array(objects.length));
        const shared = readObjectParam();
        const index = shared === null ? -1 : objects.findIndex((o) => o.norad_id === shared);
        if (index >= 0) get().focus(index);
        else if (shared !== null) writeObjectParam(null);
      } catch (e) {
        set({ status: 'error', error: errMsg(e) });
      }
    },
    loadApproaches: async () => {
      if (approachesTimer) clearTimeout(approachesTimer);
      approachesTimer = null;
      const again = (ms: number) => {
        approachesTimer = setTimeout(() => void get().loadApproaches(), ms);
      };
      try {
        const body = await api.catalogApproaches();
        if ('status' in body) {
          // Keep showing an older list while a refresh is screened.
          if (!get().approaches.data) set({ approaches: { status: 'computing', data: null, error: null } });
          again(Math.max(1, body.retry_after_s) * 1000);
          return;
        }
        set({ approaches: { status: 'ready', data: body, error: null } });
        again(APPROACHES_REFRESH_MS);
      } catch (e) {
        const data = get().approaches.data;
        set({ approaches: data ? { status: 'ready', data, error: null } : { status: 'error', data: null, error: errMsg(e) } });
        if (data) again(APPROACHES_REFRESH_MS);
      }
    },
    setPreviewApproach: (previewApproach) => set({ previewApproach }),
    togglePinnedApproach: (key) => set({ pinnedApproach: get().pinnedApproach === key ? null : key }),
    toggleType: (t) => {
      const f = get().filters;
      refilter({ ...f, types: { ...f.types, [t]: !f.types[t] } });
    },
    toggleClass: (c) => {
      const f = get().filters;
      refilter({ ...f, classes: { ...f.classes, [c]: !f.classes[c] } });
    },
    toggleOwner: (code) => {
      const f = get().filters;
      const owners = f.owners.includes(code) ? f.owners.filter((o) => o !== code) : [...f.owners, code];
      refilter({ ...f, owners });
    },
    clearOwners: () => refilter({ ...get().filters, owners: [] }),
    resetFilters: () => refilter(DEFAULT_FILTERS),
    setShowPaths: (showPaths) => set({ showPaths }),
    setHighlightDetections: (highlightDetections) => set({ highlightDetections }),
    setPanelOpen: (panelOpen) => set({ panelOpen }),
    select: (selected) => {
      set({ selected, live: null });
      writeObjectParam(selected === null ? null : (get().objects[selected]?.norad_id ?? null));
    },
    focus: (index) => {
      set({ selected: index, live: null, focusRequest: { index, nonce: (get().focusRequest?.nonce ?? 0) + 1 } });
      writeObjectParam(get().objects[index]?.norad_id ?? null);
    },
    setFailed: (failed) => {
      const prev = get().failed;
      if (prev.length === failed.length && prev.every((v, i) => v === failed[i])) return;
      refilter(get().filters, failed);
    },
    setLive: (live) => set({ live }),
    setModelLive: (modelLive) => set({ modelLive }),
    setSceneError: (sceneError) => set({ sceneError }),
    setPropagated: (propagated) => set({ propagated }),
  };
});
