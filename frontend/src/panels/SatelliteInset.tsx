import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { insetAlert, type InsetAlert } from '../globe/insetAlert';
import { useSimulation } from '../hooks/useSimulation';
import { formatCountdown } from '../lib/format';
import { useAppStore } from '../store/useAppStore';

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

/**
 * The corner window around the close-up satellite view (its children). The border turns red while a
 * critical conjunction is ahead and not yet dodged, and green while the dodge burn fires. `className`
 * places and sizes it.
 */
export default function SatelliteInset({ className = '', children }: { className?: string; children: ReactNode }) {
  const wide = useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches);
  return wide ? <InsetFrame className={className}>{children}</InsetFrame> : null;
}

function InsetFrame({ className, children }: { className: string; children: ReactNode }) {
  const sim = useSimulation();
  const screening = useAppStore((s) => s.screening);
  const simulation = useAppStore((s) => s.simulation);
  const name = useAppStore((s) => (s.scenario ? s.objects[s.scenario.primary_id]?.name : undefined));

  const approved = simulation?.approved_maneuver ?? null;
  const now = sim.currentUnix;
  const live = insetAlert({
    now,
    threats: (screening?.conjunctions ?? []).map((c) => ({ tcaUnix: c.tca_unix, critical: c.threat_state === 'CRITICAL' })),
    burns: approved ? [approved.burn_time_unix] : [],
    mitigated: simulation?.post_approval?.meets_target ?? false,
  });

  const [held, setHeld] = useState<InsetAlert | null>(null);
  const firing = live.level === 'maneuver' ? live : null;
  const firingKey = firing ? String(firing.burnUnix) : null;
  useEffect(() => {
    if (!firing) return;
    setHeld(firing);
    const t = setTimeout(() => setHeld(null), MANEUVER_WALL_HOLD_MS);
    return () => clearTimeout(t);
  }, [firingKey]); // keyed by burn: one hold per burn, not per render
  const alert = live.level === 'maneuver' ? live : held ?? live;

  const frame = FRAME[alert.level];
  const glow: CSSProperties | undefined = frame.glow
    ? { boxShadow: `0 0 0 1px ${frame.glow}, 0 0 18px color-mix(in srgb, ${frame.glow} 45%, transparent)` }
    : undefined;

  return (
    <div className={className}>
      <div className={`relative h-full w-full overflow-hidden rounded border bg-bg shadow-lg transition-[border-color,box-shadow] duration-200 motion-reduce:transition-none ${frame.border}`} style={glow}>
        {children}
        {alert.level !== 'normal' && (
          <div aria-hidden="true" className={`pointer-events-none absolute inset-0 rounded border-2 motion-safe:animate-pulse ${frame.border}`} />
        )}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-start gap-0.5 p-1.5">
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
              {approved && <span className="mono block font-normal">Δv {approved.dv_magnitude_mps.toFixed(2)} m/s</span>}
            </span>
          )}
        </div>
        <span className="sr-only" role="status">
          {alert.level === 'danger' ? 'Critical debris detected' : alert.level === 'maneuver' ? 'Satellite maneuvering to dodge the debris' : ''}
        </span>
      </div>
    </div>
  );
}
