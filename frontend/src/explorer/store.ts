import { create } from 'zustand';
import { ApiError, api } from '../api/client';
import type { CatalogObject, CatalogObjectType, CatalogResponse, OrbitClass } from '../types/api';
import { DEFAULT_FILTERS, computeMask, ownerCounts, type Filters, type OwnerCount } from './filters';

function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.status === 0 ? e.message : `${e.message} (HTTP ${e.status})`;
  return (e as Error)?.message ?? String(e);
}

export interface LiveState {
  altitudeKm: number;
  speedKms: number;
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
  panelOpen: boolean;
  selected: number | null;
  live: LiveState | null;
  /** Set when a selection should also turn the camera toward the object (search results). */
  focusRequest: { index: number; nonce: number } | null;
  sceneError: string | null;

  load: () => Promise<void>;
  toggleType: (t: CatalogObjectType) => void;
  toggleClass: (c: OrbitClass) => void;
  toggleOwner: (code: string) => void;
  clearOwners: () => void;
  resetFilters: () => void;
  setShowPaths: (on: boolean) => void;
  setPanelOpen: (open: boolean) => void;
  select: (index: number | null) => void;
  focus: (index: number) => void;
  setFailed: (failed: Uint8Array) => void;
  setLive: (live: LiveState | null) => void;
  setSceneError: (msg: string) => void;
}

export const useExplorerStore = create<ExplorerState>((set, get) => {
  const refilter = (filters: Filters, failed = get().failed) => {
    const { mask, visible, byType } = computeMask(get().objects, filters, failed);
    const sel = get().selected;
    set({ filters, failed, mask, visible, visibleByType: byType, ...(sel !== null && !mask[sel] ? { selected: null, live: null } : {}) });
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
    panelOpen: false,
    selected: null,
    live: null,
    focusRequest: null,
    sceneError: null,

    load: async () => {
      set({ status: 'loading', error: null });
      try {
        const { objects, ...meta } = await api.catalog();
        set({ objects, meta, owners: ownerCounts(objects), status: 'ready', selected: null });
        refilter(get().filters, new Uint8Array(objects.length));
      } catch (e) {
        set({ status: 'error', error: errMsg(e) });
      }
    },
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
    setPanelOpen: (panelOpen) => set({ panelOpen }),
    select: (selected) => set({ selected, live: null }),
    focus: (index) => set({ selected: index, live: null, focusRequest: { index, nonce: (get().focusRequest?.nonce ?? 0) + 1 } }),
    setFailed: (failed) => {
      const prev = get().failed;
      if (prev.length === failed.length && prev.every((v, i) => v === failed[i])) return;
      refilter(get().filters, failed);
    },
    setLive: (live) => set({ live }),
    setSceneError: (sceneError) => set({ sceneError }),
  };
});
