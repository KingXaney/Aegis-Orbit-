import type { CatalogObjectType } from '../types/api';

// The explorer's colours live once, as CSS variables in index.css. DOM styles reference them with var();
// the globe needs resolved colour strings, so it reads them from the computed style.

export const TYPE_INK: Record<CatalogObjectType, string> = {
  PAYLOAD: 'var(--x-payload)',
  DEBRIS: 'var(--x-debris)',
  ROCKET_BODY: 'var(--x-rocket)',
};

/** Magenta, the active-route colour: GPM, its orbit and the primary action. */
export const ACCENT_INK = 'var(--x-accent)';

export interface Palette {
  bg: string;
  surface: string;
  text: string;
  accent: string;
  ocean: string;
  land: string;
  coast: string;
  types: Record<CatalogObjectType, string>;
}

// Used when the variables are not available (unit tests without the stylesheet).
const FALLBACK: Palette = {
  bg: '#0b0d10',
  surface: '#14171c',
  text: '#e8eaed',
  accent: '#ff5fd2',
  ocean: '#0f1319',
  land: '#333f52',
  coast: '#56647a',
  types: { PAYLOAD: '#4fd8eb', DEBRIS: '#ffb020', ROCKET_BODY: '#d9dde3' },
};

export function readPalette(root: Element = document.documentElement): Palette {
  const style = getComputedStyle(root);
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--x-bg', FALLBACK.bg),
    surface: v('--x-surface', FALLBACK.surface),
    text: v('--x-text', FALLBACK.text),
    accent: v('--x-accent', FALLBACK.accent),
    ocean: v('--x-ocean', FALLBACK.ocean),
    land: v('--x-land', FALLBACK.land),
    coast: v('--x-coast', FALLBACK.coast),
    types: {
      PAYLOAD: v('--x-payload', FALLBACK.types.PAYLOAD),
      DEBRIS: v('--x-debris', FALLBACK.types.DEBRIS),
      ROCKET_BODY: v('--x-rocket', FALLBACK.types.ROCKET_BODY),
    },
  };
}
