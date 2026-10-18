import { useRef, useState, type KeyboardEvent } from 'react';
import { ghostCrashEvents } from '../simulation/ghosts';
import { useAppStore } from '../store/useAppStore';
import type { CommittedManeuver } from '../types/api';
import { formatCountdown, formatKm } from '../lib/format';
import { LOOK_AHEAD_S, offsetLabel, railMarkers, screenedUntil, type RailMarker, type RailTone } from './lookAhead';

const NO_BURNS: CommittedManeuver[] = [];
const TICK_S = 30 * 60;
const TICKS = Array.from({ length: LOOK_AHEAD_S / TICK_S + 1 }, (_, i) => i * TICK_S);
/** Bar heights are a share of this (px): the rail's drawing area above the axis. */
const BAR_MAX_PX = 22;

const PASS_INK: Record<RailTone, string> = {
  threat: 'bg-threat',
  watch: 'bg-tracked',
  clear: 'bg-muted/70',
};

function describe(m: RailMarker, nowUnix: number): string {
  const when = formatCountdown(m.atUnix - nowUnix);
  if (m.kind === 'burn') return `Dodge burn ${m.label}, ${when}`;
  if (m.kind === 'ghost') return `Ghost collision: ${m.label}, ${when}`;
  return `${m.name} passes at ${formatKm(m.missKm)}, ${when} (${m.state.toLowerCase()})`;
}

/**
 * The sandbox's look-ahead: the next three hours on one line, so the loop the autopilot runs is
 * visible at a glance. Passes stand taller the closer they come (red still needs a dodge), lime diamonds
 * are committed burns, red rings are ghost collisions, and the hatched stretch is beyond the horizon the
 * autopilot has screened so far. Picking a pass opens it in the mission panel.
 */
export default function LookAheadRail({ nowUnix }: { nowUnix: number }) {
  const screening = useAppStore((s) => s.screening);
  const committed = useAppStore((s) => s.simulation?.committed_maneuvers ?? NO_BURNS);
  const ghosts = useAppStore((s) => s.ghosts);
  const screeningEnd = useAppStore((s) => s.sandbox.screeningEndUnix);
  const selectedId = useAppStore((s) => s.selectedConjunctionId);
  const selectConjunction = useAppStore((s) => s.selectConjunction);
  const panelOpen = useAppStore((s) => s.missionPanelOpen);
  const togglePanel = useAppStore((s) => s.toggleMissionPanel);
  const [hover, setHover] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);

  const markers = railMarkers(screening, committed, ghostCrashEvents(ghosts, nowUnix), nowUnix);
  const unscreened = screenedUntil(screeningEnd, nowUnix);
  const hovered = markers.find((m) => m.id === hover) ?? null;
  const pending = markers.filter((m) => m.kind === 'pass' && m.tone === 'threat').length;

  // one tab stop for the whole rail (the selected pass, else the first); arrows move between passes
  const passIds = markers.filter((m) => m.kind === 'pass').map((m) => m.id);
  const tabStop = selectedId && passIds.includes(selectedId) ? selectedId : passIds[0];
  const onKeyDown = (e: KeyboardEvent) => {
    const buttons = Array.from(railRef.current?.querySelectorAll<HTMLButtonElement>('button[data-pass]') ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, to))]?.focus();
  };

  const pick = (id: string) => {
    selectConjunction(id);
    if (!panelOpen) togglePanel();
  };

  return (
    <div className="relative min-w-0 select-none">
      <div
        ref={railRef}
        className="relative h-[28px]"
        role="group"
        aria-label={`Next three hours: ${markers.length === 0 ? 'nothing scheduled' : `${markers.length} events, ${pending} still need a dodge`}. Arrow keys move between passes.`}
        onKeyDown={onKeyDown}
      >
        {unscreened !== null && (
          <div className="rail-unscreened absolute bottom-0 right-0 top-0 rounded-sm" style={{ left: `${unscreened * 100}%` }} title="Not screened yet: the autopilot looks two orbits ahead and screens more as time passes" />
        )}
        <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-px bg-line-strong" />
        {TICKS.map((t) => (
          <div key={t} aria-hidden="true" className="absolute bottom-0 h-1.5 w-px bg-line-strong" style={{ left: `${(t / LOOK_AHEAD_S) * 100}%` }} />
        ))}
        {markers.map((m) => {
          const left = `${m.x * 100}%`;
          const label = describe(m, nowUnix);
          const show = () => setHover(m.id);
          const hide = () => setHover((h) => (h === m.id ? null : h));
          if (m.kind === 'pass') {
            const selected = m.id === selectedId;
            return (
              <button
                key={m.id}
                type="button"
                data-pass
                tabIndex={m.id === tabStop ? 0 : -1}
                aria-label={label}
                aria-pressed={selected}
                onClick={() => pick(m.id)}
                onMouseEnter={show}
                onMouseLeave={hide}
                onFocus={show}
                onBlur={hide}
                className="group absolute bottom-0 top-0 w-[18px] -translate-x-1/2 rounded-sm focus-visible:outline-2 focus-visible:outline-primary"
                style={{ left }}
              >
                <span
                  className={`absolute bottom-0 left-1/2 w-[3px] -translate-x-1/2 rounded-t-sm transition-[width] duration-150 group-hover:w-[5px] ${PASS_INK[m.tone]} ${selected ? 'w-[5px] ring-1 ring-text ring-offset-1 ring-offset-panel' : ''}`}
                  style={{ height: `${Math.round(m.height * BAR_MAX_PX)}px` }}
                />
              </button>
            );
          }
          return (
            <span
              key={m.id}
              role="img"
              aria-label={label}
              onMouseEnter={show}
              onMouseLeave={hide}
              className="absolute bottom-0 flex h-full w-[14px] -translate-x-1/2 items-end justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-primary"
              style={{ left }}
            >
              {m.kind === 'burn' ? (
                <i className="mb-[-4px] block h-2 w-2 rotate-45 rounded-[1px] bg-burn shadow-[0_0_0_2px_var(--color-panel)]" />
              ) : (
                <i className="mb-[-5px] block h-2.5 w-2.5 rounded-full border-2 border-threat bg-panel" />
              )}
            </span>
          );
        })}
        {hovered && (
          <div
            role="tooltip"
            className="pointer-events-none absolute bottom-full z-10 mb-1.5 whitespace-nowrap rounded-md border border-line bg-panel-2 px-2 py-1 text-[11px] text-text shadow-lg"
            style={hovered.x < 0.2 ? { left: `${hovered.x * 100}%`, transform: 'translateX(-6px)' } : hovered.x > 0.8 ? { right: `${(1 - hovered.x) * 100}%`, transform: 'translateX(6px)' } : { left: `${hovered.x * 100}%`, transform: 'translateX(-50%)' }}
          >
            {describe(hovered, nowUnix)}
          </div>
        )}
      </div>
      <div aria-hidden="true" className="relative mt-1 h-3.5 text-[10px] leading-3.5 text-dim">
        {TICKS.map((t, i) => (
          <span
            key={t}
            className="mono absolute"
            style={i === 0 ? { left: 0 } : i === TICKS.length - 1 ? { right: 0 } : { left: `${(t / LOOK_AHEAD_S) * 100}%`, transform: 'translateX(-50%)' }}
          >
            {offsetLabel(t)}
          </span>
        ))}
      </div>
    </div>
  );
}
