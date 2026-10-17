import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// Literal class strings so Tailwind's scanner picks them up.
export const LABEL_CLASS = {
  object: 'pointer-events-none whitespace-nowrap rounded border border-line bg-panel/80 px-1.5 py-0.5 font-mono text-[10px] text-text',
  critical: 'pointer-events-none whitespace-nowrap rounded border border-threat/60 bg-panel/85 px-1.5 py-0.5 font-mono text-[10px] text-threat',
  mitigated: 'pointer-events-none whitespace-nowrap rounded border border-safe/60 bg-panel/85 px-1.5 py-0.5 font-mono text-[10px] text-safe',
  satellite: 'pointer-events-none whitespace-nowrap rounded border border-primary/60 bg-panel/85 px-1.5 py-0.5 font-mono text-[10px] text-primary',
  tick: 'pointer-events-none whitespace-nowrap font-mono text-[9px] text-dim',
  lane: 'pointer-events-none whitespace-nowrap font-mono text-[9px] text-muted',
  burn: 'pointer-events-none whitespace-nowrap rounded border border-warn/50 bg-panel/85 px-1 py-0.5 font-mono text-[9px] text-warn',
  measure: 'pointer-events-none whitespace-nowrap rounded bg-panel/85 px-1 py-0.5 font-mono text-[10px] text-threat',
} as const;

export type LabelKind = keyof typeof LABEL_CLASS;

export function makeLabel(kind: LabelKind, text = ''): CSS2DObject {
  const el = document.createElement('div');
  el.className = LABEL_CLASS[kind];
  el.textContent = text;
  if (!text) el.style.visibility = 'hidden';
  const obj = new CSS2DObject(el);
  obj.center.set(0.5, 1.2);
  return obj;
}

/** Writes to the DOM only when the text actually changes. */
export function setLabel(obj: CSS2DObject, text: string, kind?: LabelKind): void {
  const el = obj.element as HTMLDivElement;
  if (el.textContent !== text) {
    el.textContent = text;
    el.style.visibility = text ? '' : 'hidden';
  }
  if (kind && el.className !== LABEL_CLASS[kind]) el.className = LABEL_CLASS[kind];
}

export function fmtCountdown(seconds: number): string {
  const sign = seconds < 0 ? '+' : '−';
  const s = Math.abs(Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `T${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function fmtKm(km: number | null): string {
  if (km === null || !Number.isFinite(km)) return '—';
  return km < 1 ? `${(km * 1000).toFixed(0)} m` : `${km.toFixed(2)} km`;
}
