import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { insetAlert, type InsetAlert } from '../globe/insetAlert';
import { useSimulation } from '../hooks/useSimulation';
import { formatCountdown } from '../lib/format';
import { useAppStore } from '../store/useAppStore';
import type { CommittedManeuver } from '../types/api';

const NO_BURNS: CommittedManeuver[] = [];

// A burn lasts about a second of wall-clock time at 60x playback, so the inset holds its maneuver
// highlight at least this long after a burn starts.
const MANEUVER_WALL_HOLD_MS = 3000;

// The inset only exists from the md breakpoint up: below it there is no room, and a hidden second
// Cesium viewer would still cost a WebGL context.
const WIDE = '(min-width: 768px)';
const subscribeWide = (cb: () => void) => {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};

const FRAME: Record<InsetAlert['level'], { border: string; glow?: string }> = {
  normal: { border: 'border-line' },
  danger: { border: 'border-threat', glow: 'var(--color-threat)' },
  maneuver: { border: 'border-safe', glow: 'var(--color-safe)' },
};

interface InsetProps {
  /** Places and sizes the corner window. */
  className: string;
  /** Places and sizes it when expanded to the big view. */
  expandedClassName: string;
  children: ReactNode;
}

/**
 * The corner window around the close-up satellite view (its children), which can expand to fill the
 * stage. The border turns red while a critical conjunction is ahead and not yet dodged, and green while
 * the dodge burn fires.
 */
export default function SatelliteInset(props: InsetProps) {
  const wide = useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches);
  return wide ? <InsetFrame {...props} /> : null;
}

function InsetFrame({ className, expandedClassName, children }: InsetProps) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);
  const sim = useSimulation();
  const screening = useAppStore((s) => s.screening);
  const simulation = useAppStore((s) => s.simulation);
  const name = useAppStore((s) => (s.scenario ? s.objects[s.scenario.primary_id]?.name : undefined));

  const committed = simulation?.committed_maneuvers ?? NO_BURNS;
  const burnFiring = useAppStore((s) => s.burnFiring);
  const zoomInset = useAppStore((s) => s.zoomInset);
  const resetInset = useAppStore((s) => s.resetInset);
  // back from the big view, the close-up returns to its default view of the spacecraft
  const wasExpanded = useRef(false);
  useEffect(() => {
    if (wasExpanded.current && !expanded) resetInset();
    wasExpanded.current = expanded;
  }, [expanded, resetInset]);
  const now = sim.currentUnix;
  const live = insetAlert({
    now,
    threats: [
      ...(screening?.conjunctions ?? []).map((c) => ({ tcaUnix: c.tca_unix, critical: c.threat_state === 'CRITICAL', dodgeBurnUnix: null })),
      // screening sees the committed path, where a dodged pass is no longer critical: it stays a threat
      // here until its burn has fired
      ...committed.filter((m) => m.meets_target).map((m) => ({ tcaUnix: m.post_tca_unix, critical: true, dodgeBurnUnix: m.burn_time_unix })),
    ],
    burns: committed.map((m) => m.burn_time_unix),
    burnFiring,
  });

  const [held, setHeld] = useState<InsetAlert | null>(null);
  const firing = live.level === 'maneuver' ? live : null;
  const firingKey = firing ? String(firing.burnUnix) : null;
  useEffect(() => {
    if (firing) setHeld(firing);
  }, [firingKey]); // keyed by burn: one hold per burn, not per render
  // the hold runs out on its own timer, also after the burn has stopped firing
  useEffect(() => {
    if (!held) return;
    const t = setTimeout(() => setHeld(null), MANEUVER_WALL_HOLD_MS);
    return () => clearTimeout(t);
  }, [held]);
  const alert = live.level === 'maneuver' ? live : held ?? live;
  const firingManeuver = alert.level === 'maneuver'
    ? committed.find((m) => (burnFiring ? m.maneuver_id === burnFiring.maneuverId : m.burn_time_unix === alert.burnUnix)) ?? null
    : null;

  const frame = FRAME[alert.level];
  const glow: CSSProperties | undefined = frame.glow
    ? { boxShadow: `0 0 0 1px ${frame.glow}, 0 0 18px color-mix(in srgb, ${frame.glow} 45%, transparent)` }
    : undefined;

  // Expanded, the top bar and side panels cover the corners, so the caption and the button sit in a
  // centred bar above the timeline instead.
  const bar = expanded
    ? 'absolute bottom-[104px] left-1/2 flex -translate-x-1/2 items-end gap-2'
    : 'absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-1.5';
  return (
    <div className={expanded ? expandedClassName : className}>
      <div className={`relative h-full w-full overflow-hidden border bg-bg shadow-lg transition-[border-color,box-shadow] duration-200 motion-reduce:transition-none ${expanded ? '' : 'rounded'} ${frame.border}`} style={glow}>
        {/* the close-up takes the pointer: drag orbits around the spacecraft, wheel or pinch zooms; it never leaves it */}
        <div className="pointer-events-auto absolute inset-0">{children}</div>
        {alert.level !== 'normal' && (
          <div aria-hidden="true" className={`pointer-events-none absolute inset-0 border-2 motion-safe:animate-pulse ${expanded ? '' : 'rounded'} ${frame.border}`} />
        )}
        <div className={bar}>
          <div className="pointer-events-none flex flex-col items-start gap-0.5">
            <span className="rounded bg-panel/85 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted">{name ?? 'Satellite'}</span>
            {alert.level === 'danger' && (
              <span className="rounded bg-threat/90 px-1.5 py-0.5 text-[10px] font-semibold text-bg">
                Critical debris detected
                <span className="mono block font-normal">
                  TCA {formatCountdown(alert.tcaUnix - now)}
                  {alert.burnUnix !== null && ` · dodge burn ${formatCountdown(alert.burnUnix - now)}`}
                </span>
              </span>
            )}
            {alert.level === 'maneuver' && (
              <span className="rounded bg-safe/90 px-1.5 py-0.5 text-[10px] font-semibold text-bg">
                Maneuvering to dodge
                {firingManeuver && <span className="mono block font-normal">{firingManeuver.direction_label} · Δv {firingManeuver.dv_magnitude_mps.toFixed(2)} m/s</span>}
              </span>
            )}
          </div>
          <div className="pointer-events-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => zoomInset(1.6)}
              aria-label="Zoom in on the spacecraft"
              title="Zoom in (or scroll over the close-up)"
              className="rounded border border-line bg-panel/90 px-1.5 py-0.5 text-[11px] leading-none text-text hover:border-muted focus-visible:outline-2 focus-visible:outline-primary"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => zoomInset(1 / 1.6)}
              aria-label="Zoom out from the spacecraft"
              title="Zoom out (or scroll over the close-up)"
              className="rounded border border-line bg-panel/90 px-1.5 py-0.5 text-[11px] leading-none text-text hover:border-muted focus-visible:outline-2 focus-visible:outline-primary"
            >
              −
            </button>
            <button
              type="button"
              onClick={resetInset}
              aria-label="Reset the close-up to its view of the spacecraft"
              title="Back to the default view of the spacecraft"
              className="rounded border border-line bg-panel/90 px-1.5 py-0.5 text-[11px] leading-none text-text hover:border-muted focus-visible:outline-2 focus-visible:outline-primary"
            >
              ⟲
            </button>
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-pressed={expanded}
              title={expanded ? 'Back to the corner (Esc)' : 'Show the close-up in the big view'}
              className="rounded border border-line bg-panel/90 px-1.5 py-0.5 text-[10px] text-text hover:border-muted focus-visible:outline-2 focus-visible:outline-primary"
            >
              {expanded ? 'Shrink close-up' : '⤢ Expand'}
            </button>
          </div>
        </div>
        <span className="sr-only" role="status">
          {alert.level === 'danger' ? 'Critical debris detected' : alert.level === 'maneuver' ? 'Satellite maneuvering to dodge the debris' : ''}
        </span>
      </div>
    </div>
  );
}
