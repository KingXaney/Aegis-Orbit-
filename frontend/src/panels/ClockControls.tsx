import { controller, SPEED_OPTIONS } from '../simulation/controller';
import { nextEvent } from '../simulation/events';
import { ghostCrashEvents } from '../simulation/ghosts';
import { useSimulation } from '../hooks/useSimulation';
import { useAppStore } from '../store/useAppStore';
import { Badge, Button } from '../components/ui';
import { formatCountdown, formatUtc } from '../lib/format';

/**
 * The sandbox clock: it runs from the moment the scenario loads and never ends. Only pause/resume
 * and the speed remain (no scrubber, no rewind: time moves forward, as it does for the spacecraft).
 */
export default function ClockControls() {
  const sim = useSimulation();
  const scenario = useAppStore((s) => s.scenario);
  const screening = useAppStore((s) => s.screening);
  const committed = useAppStore((s) => s.simulation?.committed_maneuvers);
  const ghosts = useAppStore((s) => s.ghosts);
  const setSpeed = useAppStore((s) => s.setSpeed);
  const slowForPasses = useAppStore((s) => s.slowForPasses);
  const setSlowForPasses = useAppStore((s) => s.setSlowForPasses);
  const dataStall = useAppStore((s) => s.dataStall);
  const autoSlow = useAppStore((s) => s.autoSlow);
  const showPath = useAppStore((s) => s.layers.original);
  const toggleLayer = useAppStore((s) => s.toggleLayer);
  const busy = useAppStore((s) => s.sandbox.evaluateInFlight || s.sandbox.spawnInFlight);
  const disabled = !scenario;
  const next = nextEvent(screening, committed, sim.currentUnix, ghostCrashEvents(ghosts, sim.currentUnix));
  const nextDt = next ? next.atUnix - sim.currentUnix : null;

  return (
    <div className="pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded border border-line bg-panel/90 px-3 py-2 backdrop-blur">
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant={sim.playing ? 'secondary' : 'primary'} onClick={() => controller.toggle()} disabled={disabled} aria-label={sim.playing ? 'Pause the simulation' : 'Resume the simulation'} className="w-20">
          {sim.playing ? '❚❚ Pause' : '▶ Resume'}
        </Button>
        <label className="sr-only" htmlFor="sandbox-speed">Simulation speed</label>
        <select id="sandbox-speed" value={sim.speed} onChange={(e) => setSpeed(Number(e.target.value))} disabled={disabled} className="rounded border border-line-strong bg-panel-2 px-1.5 py-1 text-[11px] text-text">
          {SPEED_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {v}×
            </option>
          ))}
        </select>
        <Badge tone={sim.playing ? 'safe' : 'neutral'}>{sim.playing ? 'live' : 'paused'}</Badge>
      </div>
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="text-[9px] uppercase tracking-wider text-dim">Simulation time</span>
        <span className="mono text-[11px] text-text">{formatUtc(sim.currentUnix)}</span>
      </div>
      <div className="flex min-w-0 flex-col leading-tight" aria-live="polite">
        <span className="text-[9px] uppercase tracking-wider text-dim">Next event</span>
        {next && nextDt !== null ? (
          <span className={`truncate text-[11px] ${next.kind === 'burn' ? 'text-[#a3e635]' : next.kind === 'ghost' || next.critical || nextDt < 900 ? 'text-threat' : 'text-tracked'}`}>
            <span className="mono">{formatCountdown(nextDt)}</span> · {next.label}
          </span>
        ) : (
          <span className="text-[11px] text-dim">nothing ahead · spawn some junk</span>
        )}
      </div>
      <Button
        size="sm"
        variant={showPath ? 'primary' : 'secondary'}
        onClick={() => toggleLayer('original')}
        aria-pressed={showPath}
        title={showPath ? "Hide the line the spacecraft flies along (and the ghosts' courses)" : "Show the line the spacecraft flies along (and the ghosts' courses)"}
        className="ml-auto"
      >
        {showPath ? 'Path on' : 'Path off'}
      </Button>
      <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted" title="Drop to 1× around each closest approach so the pass is watchable in the Follow view">
        <input type="checkbox" className="accent-[var(--color-primary)]" checked={slowForPasses} onChange={(e) => setSlowForPasses(e.target.checked)} />
        Slow down for passes
      </label>
      {autoSlow && (
        <Badge tone={autoSlow.kind === 'burn' ? 'safe' : autoSlow.kind === 'ghost' ? 'threat' : 'info'}>
          {autoSlow.kind === 'burn' ? 'slow motion · dodge burn' : autoSlow.kind === 'ghost' ? 'slow motion · ghost collision' : 'slow motion · pass'}
        </Badge>
      )}
      {busy && <Badge tone="info">autopilot thinking…</Badge>}
      {dataStall && <Badge tone="warn">buffering orbit data…</Badge>}
    </div>
  );
}
