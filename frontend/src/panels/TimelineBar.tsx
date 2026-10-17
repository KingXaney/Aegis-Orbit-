import { useMemo } from 'react';
import { controller, SPEED_OPTIONS } from '../simulation/controller';
import { useSimulation } from '../hooks/useSimulation';
import { useAppStore } from '../store/useAppStore';
import { Button } from '../components/ui';
import { formatCountdown, formatUtc } from '../lib/format';

export default function TimelineBar() {
  const sim = useSimulation();
  const scenario = useAppStore((s) => s.scenario);
  const conj = useAppStore((s) => s.selectedConjunction());
  const maneuver = useAppStore((s) => s.selectedManeuver());
  const approvedId = useAppStore((s) => s.simulation?.approved_maneuver_id ?? null);
  const span = Math.max(sim.endUnix - sim.startUnix, 1);
  const pct = (t: number) => `${Math.min(100, Math.max(0, ((t - sim.startUnix) / span) * 100))}%`;
  const markers = useMemo(() => {
    const m: { t: number; color: string; label: string; hollow?: boolean }[] = [];
    if (conj) m.push({ t: conj.tca_unix, color: '#f87171', label: `TCA ${formatUtc(conj.tca, false).slice(0, 8)}` });
    if (maneuver) {
      m.push({ t: maneuver.burn_time_unix, color: '#a3e635', label: `burn ${formatUtc(maneuver.burn_time, false).slice(0, 8)}` });
      m.push({ t: maneuver.post_tca_unix, color: '#4ade80', label: `post-burn TCA ${formatUtc(maneuver.post_tca, false).slice(0, 8)}`, hollow: true });
    }
    return m;
  }, [conj, maneuver]);
  const tToTca = conj ? conj.tca_unix - sim.currentUnix : null;
  const disabled = !scenario;

  return (
    <div className="pointer-events-auto flex items-center gap-3 rounded border border-line bg-panel/90 px-3 py-2 backdrop-blur">
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => controller.reset()} disabled={disabled} title="Rewind to window start" aria-label="Rewind">
          ⏮
        </Button>
        <Button size="sm" variant={sim.playing ? 'primary' : 'secondary'} onClick={() => controller.toggle()} disabled={disabled} aria-label={sim.playing ? 'Pause' : 'Play'} className="w-16">
          {sim.playing ? '❚❚ Pause' : '▶ Play'}
        </Button>
        <label className="sr-only" htmlFor="speed">Simulation speed</label>
        <select id="speed" value={sim.speed} onChange={(e) => controller.setSpeed(Number(e.target.value))} disabled={disabled} className="rounded border border-line-strong bg-panel-2 px-1.5 py-1 text-[11px] text-text">
          {SPEED_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {v}×
            </option>
          ))}
        </select>
      </div>
      <div className="relative min-w-0 flex-1 pt-3 pb-2">
        <div className="pointer-events-none absolute left-0 right-0 top-[18px] h-1 rounded bg-line" />
        <div className="pointer-events-none absolute left-0 top-[18px] h-1 rounded bg-primary/60" style={{ width: pct(sim.currentUnix) }} />
        {markers.map((m) => (
          <div key={m.label} className="pointer-events-none absolute top-[10px] flex -translate-x-1/2 flex-col items-center" style={{ left: pct(m.t) }} title={m.label}>
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
          <span className="hidden min-w-0 flex-1 truncate text-center lg:inline">
            {markers.map((m) => (
              <span key={m.label} className="mono mx-1.5 inline-flex items-center gap-1" style={{ color: m.color }}>
                <span className="inline-block h-2 w-0.5" style={{ background: m.color }} />
                {m.label}
              </span>
            ))}
          </span>
          <span className="mono">{formatUtc(sim.endUnix, false)}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <div className="hidden xl:block">
          <div className="text-[9px] uppercase tracking-wider text-dim">Simulation time</div>
          <div className="mono text-xs text-text">{formatUtc(sim.currentUnix)}</div>
        </div>
        <div className="xl:hidden">
          <div className="text-[9px] uppercase tracking-wider text-dim">Sim time</div>
          <div className="mono text-xs text-text">{formatUtc(sim.currentUnix, false)}</div>
        </div>
        <div className="w-[96px]">
          <div className="text-[9px] uppercase tracking-wider text-dim">To closest approach</div>
          <div className={`mono text-xs ${tToTca !== null && tToTca > 0 && tToTca < 900 ? 'text-threat' : 'text-text'}`}>{tToTca === null ? '—' : formatCountdown(tToTca)}</div>
        </div>
        {maneuver && (
          <Button size="sm" variant="ghost" onClick={() => controller.seek(maneuver.burn_time_unix - 120)} title={approvedId === maneuver.maneuver_id ? 'Jump to the approved burn' : 'Jump to the selected candidate burn'}>
            Jump to burn
          </Button>
        )}
      </div>
    </div>
  );
}
