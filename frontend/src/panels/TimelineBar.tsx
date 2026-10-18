import { useEffect, useMemo, useState } from 'react';
import { controller, SPEED_OPTIONS } from '../simulation/controller';
import type { Ghost } from '../simulation/ghosts';
import { useSimulation } from '../hooks/useSimulation';
import { useAppStore } from '../store/useAppStore';
import { Badge, Button } from '../components/ui';
import { formatCountdown, formatUtc } from '../lib/format';
import type { CommittedManeuver } from '../types/api';
import { DEFAULT_SCREENING_RADIUS_KM, efficiency, nextEvent, timelineEvents, type TimelineEvent } from './timelineEvents';

const NO_BURNS: CommittedManeuver[] = [];
const NO_GHOSTS: Ghost[] = [];

// Detection markers by threat state: critical passes stand out, monitored ones are short ticks.
const DETECTION_MARK: Record<string, { color: string; h: string }> = {
  CRITICAL: { color: 'var(--color-threat)', h: 'h-5' },
  ELEVATED: { color: 'var(--color-warn)', h: 'h-4' },
  UNVERIFIED: { color: 'var(--color-warn)', h: 'h-3' },
};
const MONITORED_MARK = { color: 'var(--color-tracked)', h: 'h-2.5' };
// a pass a committed burn dodged keeps a (faded) critical mark: screening of the new path no longer calls it critical
const DODGED_MARK = { color: 'var(--color-threat)', h: 'h-5', faded: true };

// "Next event" lands a little before the event, so the detection or the burn plays out on screen.
const LEAD_S: Record<TimelineEvent['kind'], number> = { detection: 30, burn: 60 };

function eventTitle(e: TimelineEvent): string {
  const at = formatUtc(e.t, false).slice(0, 8);
  return e.kind === 'burn'
    ? `${at} burn: ${e.directionLabel} ${e.dvMps.toFixed(2)} m/s${e.source === 'autopilot' ? ' (autopilot)' : ''}`
    : `${at} ${e.name} enters the detection radius (${e.dodged ? 'dodged, now passes' : `${e.state.toLowerCase()}, miss`} ${e.missKm < 1 ? `${Math.round(e.missKm * 1000)} m` : `${e.missKm.toFixed(1)} km`}${e.dodged ? ' away' : ''})`;
}

export default function TimelineBar() {
  const sim = useSimulation();
  const scenario = useAppStore((s) => s.scenario);
  const conj = useAppStore((s) => s.selectedConjunction());
  const maneuver = useAppStore((s) => s.selectedManeuver());
  const approvedId = useAppStore((s) => s.simulation?.approved_maneuver_id ?? null);
  const screening = useAppStore((s) => s.screening);
  const committed = useAppStore((s) => s.simulation?.committed_maneuvers) ?? NO_BURNS;
  const plan = useAppStore((s) => s.plan);
  const ghosts = useAppStore((s) => s.ghosts) ?? NO_GHOSTS;
  const autoSlow = useAppStore((s) => s.autoSlow);
  const setSpeed = useAppStore((s) => s.setSpeed);
  const scenarioKey = useAppStore((s) => (s.scenario ? `${s.scenario.scenario_id}:${s.scenario.simulation.reset_count}` : ''));
  const radiusKm = Number(screening?.thresholds?.screening_radius_km) || DEFAULT_SCREENING_RADIUS_KM;
  const events = useMemo(() => timelineEvents(screening?.conjunctions ?? [], committed, radiusKm), [screening, committed, radiusKm]);
  const eff = useMemo(() => efficiency(screening?.conjunctions ?? [], committed), [screening, committed]);
  // compute time of each plan made this session, keyed by conjunction (a re-plan replaces its entry)
  const [planSeconds, setPlanSeconds] = useState<Record<string, number>>({});
  useEffect(() => setPlanSeconds({}), [scenarioKey]);
  useEffect(() => {
    if (plan?.stats?.duration_s !== undefined) setPlanSeconds((prev) => ({ ...prev, [plan.conjunction_id]: plan.stats.duration_s }));
  }, [plan]);
  const planTotalS = Object.values(planSeconds).reduce((a, b) => a + b, 0);
  const next = nextEvent(events, sim.currentUnix);
  const span = Math.max(sim.endUnix - sim.startUnix, 1);
  const pct = (t: number) => `${Math.min(100, Math.max(0, ((t - sim.startUnix) / span) * 100))}%`;
  const markers = useMemo(() => {
    const m: { t: number; color: string; label: string; hollow?: boolean }[] = [];
    if (conj) m.push({ t: conj.tca_unix, color: '#f87171', label: `TCA ${formatUtc(conj.tca, false).slice(0, 8)}` });
    if (maneuver) {
      m.push({ t: maneuver.burn_time_unix, color: '#a3e635', label: `burn ${formatUtc(maneuver.burn_time, false).slice(0, 8)}` });
      m.push({ t: maneuver.post_tca_unix, color: '#4ade80', label: `post-burn TCA ${formatUtc(maneuver.post_tca, false).slice(0, 8)}`, hollow: true });
    }
    // where each ghost meets the debris its burn avoided
    for (const g of ghosts) m.push({ t: g.crashUnix, color: '#f87171', label: `ghost ${g.index} meets ${g.secondaryName} ${formatUtc(g.crashUnix, false).slice(0, 8)}`, hollow: true });
    return m;
  }, [conj, maneuver, ghosts]);
  const tToTca = conj ? conj.tca_unix - sim.currentUnix : null;
  const disabled = !scenario;

  return (
    <div className="hud pointer-events-auto px-3 py-2">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => controller.reset()} disabled={disabled} title="Rewind to window start" aria-label="Rewind">
            ⏮
          </Button>
          <Button size="sm" variant={sim.playing ? 'primary' : 'secondary'} onClick={() => controller.toggle()} disabled={disabled} aria-label={sim.playing ? 'Pause' : 'Play'} className="w-16">
            {sim.playing ? '❚❚ Pause' : '▶ Play'}
          </Button>
          <label className="sr-only" htmlFor="speed">Simulation speed</label>
          <select id="speed" value={sim.speed} onChange={(e) => setSpeed(Number(e.target.value))} disabled={disabled} className="hud-select mono h-7 text-[11px]">
            {SPEED_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v}×
              </option>
            ))}
          </select>
          {autoSlow && <Badge tone={autoSlow.kind === 'ghost' ? 'threat' : autoSlow.kind === 'burn' ? 'safe' : 'info'}>{autoSlow.kind === 'ghost' ? 'slow motion · ghost collision' : autoSlow.kind === 'burn' ? 'slow motion · dodge burn' : 'slow motion · pass'}</Badge>}
        </div>
        <div className="relative min-w-0 flex-1 pt-3 pb-2">
          <div className="pointer-events-none absolute left-0 right-0 top-[18px] h-1 rounded bg-line" />
          <div className="pointer-events-none absolute left-0 top-[18px] h-1 rounded bg-primary/60" style={{ width: pct(sim.currentUnix) }} />
          {events.map((e) => {
            if (e.kind === 'burn') {
              // a committed burn: where the spacecraft changes its path
              return (
                <div key={`b:${e.maneuverId}`} aria-hidden="true" className="pointer-events-none absolute top-[4px] flex -translate-x-1/2 flex-col items-center" style={{ left: pct(e.t) }}>
                  <div className="h-0 w-0 border-x-[4px] border-b-[6px] border-x-transparent" style={{ borderBottomColor: 'var(--color-safe)' }} />
                  <div className="h-5 w-0.5" style={{ background: 'var(--color-safe)' }} />
                </div>
              );
            }
            const mark: { color: string; h: string; faded?: boolean } = e.dodged ? DODGED_MARK : DETECTION_MARK[e.state] ?? MONITORED_MARK;
            const selected = conj?.conjunction_id === e.conjunctionId;
            return (
              <div key={`d:${e.conjunctionId}`} aria-hidden="true" className="pointer-events-none absolute top-[10px] flex -translate-x-1/2 flex-col items-center" style={{ left: pct(e.t) }}>
                <div className={`${mark.h} ${selected ? 'w-1' : 'w-0.5'}`} style={{ background: mark.color, opacity: mark.faded ? 0.45 : 1 }} />
              </div>
            );
          })}
          {markers.filter((m) => !m.label.startsWith('TCA')).map((m) => (
            <div key={m.label} aria-hidden="true" className="pointer-events-none absolute top-[10px] flex -translate-x-1/2 flex-col items-center" style={{ left: pct(m.t) }}>
              <div className="h-5 w-0.5" style={{ background: m.color, opacity: m.hollow ? 0.6 : 1 }} />
            </div>
          ))}
          <input
            type="range"
            className="scrubber relative"
            min={sim.startUnix}
            max={sim.endUnix}
            step={1}
            value={sim.currentUnix}
            disabled={disabled}
            onChange={(e) => controller.seek(Number(e.target.value))}
            aria-label="Simulation time"
          />
          <div className="mt-0.5 flex items-center justify-between gap-3 text-[9px] text-dim">
            <span className="mono">{formatUtc(sim.startUnix, false)}</span>
            <span className="min-w-0 flex-1" />
            <span className="mono">{formatUtc(sim.endUnix, false)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="hidden xl:block">
            <div className="text-[10px] text-dim">Simulation time</div>
            <div className="mono text-xs text-text">{formatUtc(sim.currentUnix)}</div>
          </div>
          <div className="xl:hidden">
            <div className="text-[10px] text-dim">Sim time</div>
            <div className="mono text-xs text-text">{formatUtc(sim.currentUnix, false)}</div>
          </div>
          <div className="w-[96px]">
            <div className="text-[10px] text-dim">To closest approach</div>
            <div className={`mono text-xs ${tToTca !== null && tToTca > 0 && tToTca < 900 ? 'text-threat' : 'text-text'}`}>{tToTca === null ? '—' : formatCountdown(tToTca)}</div>
          </div>
          {maneuver && (
            <Button size="sm" variant="ghost" onClick={() => controller.seek(maneuver.burn_time_unix - 120)} title={approvedId === maneuver.maneuver_id ? 'Jump to the approved burn' : 'Jump to the selected candidate burn'}>
              Jump to burn
            </Button>
          )}
          {next && (
            <Button size="sm" variant="ghost" onClick={() => controller.seek(Math.max(sim.startUnix, next.t - LEAD_S[next.kind]))} title={`Jump to just before: ${eventTitle(next)}`}>
              Next {next.kind === 'burn' ? 'burn' : 'detection'} ⏭
            </Button>
          )}
        </div>
      </div>
      {/* efficiency: what screening found, what is still critical, and what the dodges cost */}
      <div className="mt-1 truncate border-t border-line pt-1 text-center text-[10px] text-muted" title={events.map(eventTitle).join('\n')}>
        {screening ? (
          <>
            <span className="mono" style={{ color: 'var(--color-tracked)' }}>{eff.passes} passes · {eff.objects} objects detected</span>
            <span className="mx-1.5 text-dim">|</span>
            <span className="mono" style={{ color: eff.criticalLeft ? 'var(--color-threat)' : 'var(--color-safe)' }}>{eff.criticalLeft} critical left</span>
            <span className="mx-1.5 text-dim">|</span>
            <span className="mono" style={{ color: 'var(--color-safe)' }}>
              {eff.dodged} dodged · Δv {eff.totalDvMps.toFixed(2)} m/s
              {eff.closestBeforeKm !== null && eff.closestAfterKm !== null && ` · closest ${Math.round(eff.closestBeforeKm * 1000)} m → ${eff.closestAfterKm.toFixed(2)} km`}
            </span>
            <span className="mx-1.5 text-dim">|</span>
            <span className="mono">
              screening {Number(screening.stats?.duration_s ?? 0).toFixed(2)} s{planTotalS > 0 && ` · planning ${planTotalS.toFixed(1)} s`}
            </span>
          </>
        ) : (
          <span>Screen conjunctions to mark detections and burns</span>
        )}
      </div>
    </div>
  );
}
