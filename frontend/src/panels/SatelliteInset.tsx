import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { insetAlert, type InsetAlert } from '../globe/insetAlert';
import { useSimulation } from '../hooks/useSimulation';
import { formatCountdown, formatUtc } from '../lib/format';
import { aliveGhosts, formatMiss, ghostLabel, ghostWarning } from '../simulation/ghosts';
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
  ghost: { border: 'border-threat', glow: 'var(--color-threat)' },
};

// The target tabs: the real spacecraft, then one per ghost flying right now.
const tabClass = (selected: boolean, pulse: boolean) =>
  `rounded-[5px] border px-1.5 py-0.5 text-[10px] focus-visible:outline-2 focus-visible:outline-primary ${
    pulse ? 'border-threat bg-threat/20 text-threat motion-safe:animate-pulse' : selected ? 'border-text bg-panel/90 text-text' : 'border-line bg-panel/85 text-muted hover:border-muted'
  }`;

const focusTabClass = (selected: boolean, pulse: boolean) =>
  `flex h-[32px] items-center rounded-md border px-2.5 text-[12px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
    pulse ? 'border-threat bg-threat/20 text-threat motion-safe:animate-pulse' : selected ? 'border-text bg-text text-bg' : 'border-line-strong bg-panel-2 text-muted hover:border-muted hover:text-text'
  }`;

// Corner controls are compact; the focus view's controls are full-size targets.
const cornerButton = 'flex h-[24px] min-w-[24px] items-center justify-center rounded-[5px] border border-line bg-panel/90 px-1.5 text-[11px] leading-none text-text hover:border-muted focus-visible:outline-2 focus-visible:outline-primary';
const focusButton = 'flex h-[32px] min-w-[32px] items-center justify-center gap-1.5 rounded-md border border-line-strong bg-panel-2 px-2.5 text-[12px] text-text transition-[border-color,transform] duration-150 hover:border-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.97] motion-reduce:active:scale-100';

/** "8 m", "640 m", "12.4 km": the close-up camera's distance. */
function formatRange(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km`;
}

// The zoom slider is logarithmic (each step the same ratio) and runs far → near, left to right.
const SLIDER_STEPS = 1000;
const sliderToRange = (t: number, min: number, max: number) => max * Math.pow(min / max, t / SLIDER_STEPS);
const rangeToSlider = (m: number, min: number, max: number) => Math.round((Math.log(max / m) / Math.log(max / min)) * SLIDER_STEPS);

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
  const expanded = useAppStore((s) => s.insetExpanded);
  const setExpanded = useAppStore((s) => s.setInsetExpanded);
  // the window narrowed below the inset's breakpoint: leave the focus view so the HUD comes back
  useEffect(() => {
    if (!wide && expanded) setExpanded(false);
  }, [wide, expanded, setExpanded]);
  return wide ? <InsetFrame {...props} /> : null;
}

function InsetFrame({ className, expandedClassName, children }: InsetProps) {
  const expanded = useAppStore((s) => s.insetExpanded);
  const setExpanded = useAppStore((s) => s.setInsetExpanded);
  const camera = useAppStore((s) => s.insetCamera);
  const requestRange = useAppStore((s) => s.requestInsetRange);
  const expandRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, setExpanded]);
  // focus follows the view: into the focus view's Back button, and back to Expand when it closes
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    (expanded ? backRef : expandRef).current?.focus();
  }, [expanded]);
  const sim = useSimulation();
  const screening = useAppStore((s) => s.screening);
  const simulation = useAppStore((s) => s.simulation);
  const name = useAppStore((s) => (s.scenario ? s.objects[s.scenario.primary_id]?.name : undefined));

  const committed = simulation?.committed_maneuvers ?? NO_BURNS;
  const burnFiring = useAppStore((s) => s.burnFiring);
  const zoomInset = useAppStore((s) => s.zoomInset);
  const resetInset = useAppStore((s) => s.resetInset);
  const ghosts = useAppStore((s) => s.ghosts);
  const insetTarget = useAppStore((s) => s.insetTarget);
  const setInsetTarget = useAppStore((s) => s.setInsetTarget);
  // back from the big view, the close-up returns to its default view of the spacecraft
  const wasExpanded = useRef(false);
  useEffect(() => {
    if (wasExpanded.current && !expanded) resetInset();
    wasExpanded.current = expanded;
  }, [expanded, resetInset]);
  const now = sim.currentUnix;
  // ghosts flying at this time, the one the close-up follows, and the one about to collide
  const alive = aliveGhosts(ghosts, now);
  const tracked = insetTarget !== 'primary' ? alive.find((g) => g.id === insetTarget) ?? null : null;
  const warn = ghostWarning(ghosts, now);
  // the corner is narrow: drop a parenthetical suffix such as "(sandbox junk)" from the debris name
  const shortName = (name: string) => name.replace(/\s*\(.*\)\s*$/, '');
  const live = insetAlert({
    now,
    ghost: tracked ? { crashUnix: tracked.crashUnix, missKm: tracked.missKm } : null,
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
  const alert = live.level === 'ghost' || live.level === 'maneuver' ? live : held ?? live;
  const firingManeuver = alert.level === 'maneuver'
    ? committed.find((m) => (burnFiring ? m.maneuver_id === burnFiring.maneuverId : m.burn_time_unix === alert.burnUnix)) ?? null
    : null;

  const frame = FRAME[alert.level];
  const glow: CSSProperties | undefined = frame.glow
    ? { boxShadow: `0 0 0 1px ${frame.glow}, 0 0 18px color-mix(in srgb, ${frame.glow} 45%, transparent)` }
    : undefined;

  const tabs =
    alive.length > 0 ? (
      <div role="tablist" aria-label="What the close-up follows" className="pointer-events-auto flex flex-wrap items-center gap-1">
        <button type="button" role="tab" aria-selected={!tracked} onClick={() => setInsetTarget('primary')} title={name ?? 'The spacecraft'} className={expanded ? focusTabClass(!tracked, false) : tabClass(!tracked, false)}>
          {name ? name.split(' ')[0] : 'Satellite'}
        </button>
        {alive.map((g) => (
          <button
            key={g.id}
            type="button"
            role="tab"
            aria-selected={tracked?.id === g.id}
            onClick={() => setInsetTarget(g.id)}
            title={`${ghostLabel(g)} · meets ${g.secondaryName} at ${formatUtc(g.crashUnix, false).slice(0, 8)} UTC (${formatMiss(g.missKm)})`}
            className={expanded ? focusTabClass(tracked?.id === g.id, warn?.ghost.id === g.id) : tabClass(tracked?.id === g.id, warn?.ghost.id === g.id)}
          >
            Ghost {g.index}
          </button>
        ))}
      </div>
    ) : (
      <span className={`rounded-[5px] bg-panel/90 px-1.5 py-0.5 text-muted ${expanded ? 'text-[12px]' : 'text-[10px]'}`}>{name ?? 'Satellite'}</span>
    );

  const alerts = (
    <>
      {tracked && <span className="rounded-[5px] bg-panel/90 px-1.5 py-0.5 text-[10px] text-primary">Ghost {tracked.index} · no dodge · ghost &amp; debris enlarged</span>}
      {alert.level === 'ghost' && (
        <span className="rounded bg-threat/90 px-1.5 py-0.5 text-[10px] font-semibold text-bg">
          {alert.crashed ? `Collision · would have passed ${formatMiss(alert.missKm)}` : `Collision course · ${shortName(tracked?.secondaryName ?? 'debris')}`}
          <span className="mono block font-normal">
            {alert.crashed ? `inside the ${tracked?.criticalRadiusKm ?? 5} km safety radius` : `${formatCountdown(alert.crashUnix - now)} · closest ${formatMiss(alert.missKm)}`}
          </span>
        </span>
      )}
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
    </>
  );

  return (
    <div className={expanded ? expandedClassName : className}>
      <div className={`relative h-full w-full overflow-hidden border bg-bg shadow-lg transition-[border-color,box-shadow] duration-200 motion-reduce:transition-none ${expanded ? '' : 'rounded'} ${frame.border}`} style={glow}>
        {/* the close-up takes the pointer: drag orbits around the spacecraft, wheel or pinch zooms; it never leaves it */}
        <div className="pointer-events-auto absolute inset-0">{children}</div>
        {alert.level !== 'normal' && (
          <div aria-hidden="true" className={`pointer-events-none absolute inset-0 border-2 motion-safe:animate-pulse ${expanded ? '' : 'rounded'} ${frame.border}`} />
        )}
        {expanded ? (
          // The focus view: the rest of the HUD steps aside (see App), so its controls sit along the top.
          <>
            <div role="toolbar" aria-label="Close-up controls" className="pointer-events-none absolute inset-x-3 top-3 flex flex-wrap items-start justify-between gap-2">
              <div className="hud pointer-events-auto flex flex-wrap items-center gap-2 p-1.5">
                <button ref={backRef} type="button" onClick={() => setExpanded(false)} className={focusButton} title="Back to the globe (Esc)">
                  <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5">
                    <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Back to globe
                  <kbd className="mono rounded border border-line px-1 text-[10px] leading-4 text-dim">Esc</kbd>
                </button>
                {tabs}
              </div>
              <div className="hud pointer-events-auto flex items-center gap-2 px-2 py-1.5">
                <button type="button" onClick={() => zoomInset(1 / 1.4)} aria-label="Zoom out from the spacecraft" title="Zoom out (or scroll over the close-up)" className={focusButton}>
                  −
                </button>
                <label htmlFor="inset-zoom" className="sr-only">
                  Distance from the spacecraft
                </label>
                <input
                  id="inset-zoom"
                  type="range"
                  min={0}
                  max={SLIDER_STEPS}
                  step={1}
                  disabled={!camera}
                  value={camera ? rangeToSlider(camera.rangeM, camera.minM, camera.maxM) : 0}
                  onChange={(e) => camera && requestRange(sliderToRange(Number(e.target.value), camera.minM, camera.maxM))}
                  aria-valuetext={camera ? `${formatRange(camera.rangeM)} from the spacecraft` : undefined}
                  title="Distance from the spacecraft: left is far, right is close. Drag the view to look around it."
                  className="hud-range w-36 xl:w-48"
                />
                <button type="button" onClick={() => zoomInset(1.4)} aria-label="Zoom in on the spacecraft" title="Zoom in (or scroll over the close-up)" className={focusButton}>
                  +
                </button>
                <span className="mono w-[64px] text-right text-[12px] text-text" aria-hidden="true">
                  {camera ? formatRange(camera.rangeM) : '—'}
                </span>
                <button type="button" onClick={resetInset} className={focusButton} title="Back to the default view of the spacecraft">
                  Reset view
                </button>
              </div>
            </div>
            <div className="pointer-events-none absolute left-3 top-[72px] flex max-w-[320px] flex-col items-start gap-1">{alerts}</div>
          </>
        ) : (
          <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-1.5">
            <div className="pointer-events-none flex flex-col items-start gap-0.5">
              {tabs}
              {alerts}
            </div>
            <div className="pointer-events-auto flex items-center gap-1">
              <button type="button" onClick={() => zoomInset(1.6)} aria-label="Zoom in on the spacecraft" title="Zoom in (or scroll over the close-up)" className={cornerButton}>
                +
              </button>
              <button type="button" onClick={() => zoomInset(1 / 1.6)} aria-label="Zoom out from the spacecraft" title="Zoom out (or scroll over the close-up)" className={cornerButton}>
                −
              </button>
              <button type="button" onClick={resetInset} aria-label="Reset the close-up to its view of the spacecraft" title="Back to the default view of the spacecraft" className={cornerButton}>
                ⟲
              </button>
              <button ref={expandRef} type="button" onClick={() => setExpanded(true)} title="Show the close-up in the big view" className={cornerButton}>
                ⤢ Expand
              </button>
            </div>
          </div>
        )}
        <span className="sr-only" role="status">
          {alert.level === 'ghost'
            ? alert.crashed ? 'The ghost met the debris' : 'The ghost is on a collision course with the debris'
            : alert.level === 'danger' ? 'Critical debris detected' : alert.level === 'maneuver' ? 'Satellite maneuvering to dodge the debris' : ''}
        </span>
      </div>
    </div>
  );
}
