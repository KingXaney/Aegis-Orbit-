import type { CatalogObject, CatalogObjectType, OrbitClass } from '../types/api';

export const OBJECT_TYPES: CatalogObjectType[] = ['PAYLOAD', 'DEBRIS', 'ROCKET_BODY'];
export const ORBIT_CLASSES: OrbitClass[] = ['LEO', 'MEO', 'GEO', 'HEO'];

export const TYPE_LABEL: Record<CatalogObjectType, string> = {
  PAYLOAD: 'Active satellite',
  DEBRIS: 'Debris',
  ROCKET_BODY: 'Rocket body',
};

export const TYPE_COLOR: Record<CatalogObjectType, string> = {
  PAYLOAD: '#5ce1f0',
  DEBRIS: '#ff6b3d',
  ROCKET_BODY: '#f4c542',
};

export const ORBIT_CLASS_LABEL: Record<OrbitClass, string> = {
  LEO: 'Low Earth orbit',
  MEO: 'Medium Earth orbit',
  GEO: 'Geostationary orbit',
  HEO: 'Highly elliptical orbit',
};

/** Above this many visible objects, the orbit-paths switch draws only the selected object's orbit. */
export const MAX_PATHS = 300;

export interface Filters {
  types: Record<CatalogObjectType, boolean>;
  classes: Record<OrbitClass, boolean>;
  /** Selected owner codes; empty means every operator. */
  owners: string[];
}

export const DEFAULT_FILTERS: Filters = {
  types: { PAYLOAD: true, DEBRIS: true, ROCKET_BODY: true },
  classes: { LEO: true, MEO: true, GEO: true, HEO: true },
  owners: [],
};

/** How many filter groups differ from the defaults (for the badge on the Filters button). */
export function activeFilterCount(f: Filters): number {
  return (
    Number(Object.values(f.types).some((on) => !on)) +
    Number(Object.values(f.classes).some((on) => !on)) +
    Number(f.owners.length > 0)
  );
}

/** Owner key used for objects without a SATCAT owner. */
export const UNKNOWN_OWNER = '?';

export function ownerOf(o: CatalogObject): string {
  return o.owner ?? UNKNOWN_OWNER;
}

export function matches(o: CatalogObject, f: Filters, owners: Set<string> | null): boolean {
  return f.types[o.type] && f.classes[o.orbit_class] && (owners === null || owners.has(ownerOf(o)));
}

export interface MaskResult {
  mask: Uint8Array;
  visible: number;
  byType: Record<CatalogObjectType, number>;
}

/** 1 for every object that passes the filters and propagates; `failed` marks objects SGP4 cannot propagate. */
export function computeMask(objects: CatalogObject[], f: Filters, failed?: Uint8Array): MaskResult {
  const owners = f.owners.length ? new Set(f.owners) : null;
  const mask = new Uint8Array(objects.length);
  const byType: Record<CatalogObjectType, number> = { PAYLOAD: 0, DEBRIS: 0, ROCKET_BODY: 0 };
  let visible = 0;
  for (let i = 0; i < objects.length; i++) {
    if (failed?.[i] || !matches(objects[i], f, owners)) continue;
    mask[i] = 1;
    visible++;
    byType[objects[i].type]++;
  }
  return { mask, visible, byType };
}

export interface OwnerCount {
  code: string;
  count: number;
}

/** Operators by number of catalogued objects, largest first. */
export function ownerCounts(objects: CatalogObject[]): OwnerCount[] {
  const counts = new Map<string, number>();
  for (const o of objects) counts.set(ownerOf(o), (counts.get(ownerOf(o)) ?? 0) + 1);
  return [...counts.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/** Name or NORAD ID search, best matches first: exact ID, then name prefix, then name substring. */
export function findObjects(objects: CatalogObject[], query: string, limit = 8): number[] {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const exact: number[] = [];
  const prefix: number[] = [];
  const contains: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    if (String(o.norad_id) === q) exact.push(i);
    else if (o.name.startsWith(q)) prefix.push(i);
    else if (o.name.includes(q)) contains.push(i);
    if (exact.length + prefix.length >= limit) break;
  }
  return [...exact, ...prefix, ...contains].slice(0, limit);
}
