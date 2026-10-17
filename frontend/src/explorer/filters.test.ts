import { describe, expect, it } from 'vitest';
import type { CatalogObject } from '../types/api';
import { DEFAULT_FILTERS, computeMask, findObjects, ownerCounts } from './filters';

function obj(partial: Partial<CatalogObject>): CatalogObject {
  return {
    norad_id: 1, name: 'X', type: 'PAYLOAD', owner: 'US', launch_date: null, intl_designator: null, orbit_class: 'LEO',
    inclination_deg: 0, period_min: 90, perigee_km: 400, apogee_km: 410, epoch: '2026-10-17T00:00:00Z', tle1: '', tle2: '',
    ...partial,
  };
}

const objects = [
  obj({ norad_id: 25544, name: 'ISS (ZARYA)', owner: 'ISS' }),
  obj({ norad_id: 2, name: 'COSMOS 2251 DEB', type: 'DEBRIS', owner: 'CIS' }),
  obj({ norad_id: 3, name: 'CZ-3B R/B', type: 'ROCKET_BODY', owner: 'PRC', orbit_class: 'HEO' }),
  obj({ norad_id: 4, name: 'INTELSAT 901', owner: 'ITSO', orbit_class: 'GEO' }),
  obj({ norad_id: 5, name: 'UNKNOWN DEB', type: 'DEBRIS', owner: null }),
];

describe('computeMask', () => {
  it('shows everything by default and counts by type', () => {
    const r = computeMask(objects, DEFAULT_FILTERS);
    expect(r.visible).toBe(5);
    expect(r.byType).toEqual({ PAYLOAD: 2, DEBRIS: 2, ROCKET_BODY: 1 });
  });

  it('combines type, class and operator filters', () => {
    const f = { ...DEFAULT_FILTERS, types: { ...DEFAULT_FILTERS.types, DEBRIS: false }, classes: { ...DEFAULT_FILTERS.classes, GEO: false } };
    expect([...computeMask(objects, f).mask]).toEqual([1, 0, 1, 0, 0]);
    expect([...computeMask(objects, { ...DEFAULT_FILTERS, owners: ['CIS', '?'] }).mask]).toEqual([0, 1, 0, 0, 1]);
  });

  it('hides objects SGP4 could not propagate', () => {
    const r = computeMask(objects, DEFAULT_FILTERS, new Uint8Array([0, 0, 1, 0, 0]));
    expect(r.visible).toBe(4);
    expect(r.byType.ROCKET_BODY).toBe(0);
  });
});

describe('ownerCounts', () => {
  it('sorts operators by count and keys missing owners as unknown', () => {
    const counts = ownerCounts([...objects, obj({ owner: 'CIS' })]);
    expect(counts[0]).toEqual({ code: 'CIS', count: 2 });
    expect(counts.find((c) => c.code === '?')?.count).toBe(1);
  });
});

describe('findObjects', () => {
  it('ranks an exact NORAD ID first, then name prefix, then substring', () => {
    expect(findObjects(objects, '25544')).toEqual([0]);
    expect(findObjects(objects, 'deb')).toEqual([1, 4]);
    expect(findObjects(objects, 'cos')).toEqual([1]);
    expect(findObjects(objects, '  ')).toEqual([]);
  });
});
