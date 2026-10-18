import type { JunkKind } from '../types/api';

/**
 * The junk the sandbox spawns (a random mix of these). Bands mirror backend/app/simulation/sandbox.py;
 * the backend's numbers (from the spawn response) are what the UI reports afterwards.
 */
export interface JunkKindInfo {
  kind: JunkKind;
  label: string;
  blurb: string;
  bandKm: [number, number];
  swatch: string;
}

export const JUNK_KINDS: JunkKindInfo[] = [
  { kind: 'fragment', label: 'Fragments', blurb: 'Small and fast, cross inside the critical radius: the autopilot has to dodge them.', bandKm: [0.1, 3], swatch: '#cbd5e1' },
  { kind: 'rocket_body', label: 'Rocket bodies', blurb: 'Spent upper stages a few km off: tracked, sometimes close enough to need a burn.', bandKm: [3, 10], swatch: '#94a3b8' },
  { kind: 'dead_satellite', label: 'Dead satellites', blurb: 'Nearly co-orbital, drift past slowly in the outer band.', bandKm: [10, 22], swatch: '#60a5fa' },
];

export function junkKindInfo(kind: JunkKind): JunkKindInfo {
  return JUNK_KINDS.find((k) => k.kind === kind) ?? JUNK_KINDS[0];
}
