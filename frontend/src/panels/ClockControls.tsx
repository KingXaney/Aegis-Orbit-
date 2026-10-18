import { controller, SPEED_OPTIONS } from '../simulation/controller';
import { nextEvent } from '../simulation/events';
import { ghostCrashEvents } from '../simulation/ghosts';
import { useSimulation } from '../hooks/useSimulation';
import { useAppStore } from '../store/useAppStore';
import { formatCountdown, formatUtc } from '../lib/format';
import LookAheadRail from '../sandbox/LookAheadRail';

function PlayIcon({ playing }: { playing: boolean }) {
  return playing ? (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5">
      <rect x="3.5" y="3" width="3" height="10" rx="0.8" fill="currentColor" />
      <rect x="9.5" y="3" width="3" height="10" rx="0.8" fill="currentColor" />
    </svg>
  ) : (
    // nudged right: a triangle's visual centre sits left of its box
    <svg aria-hidden="true" viewBox="0 0 16 16" className="ml-0.5 h-3.5 w-3.5">
      <path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.2-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5z" fill="currentColor" />
    </svg>
  );
}

/**
 * The sandbox clock: it runs from the moment the scenario loads and never ends. Only pause/resume
 * and the speed remain (no scrubber, no rewind: time moves forward, as it does for the spacecraft).
 * Under it, the look-ahead rail shows what the next three hours hold.
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
  const disabled = !scenario;
  const next = nextEvent(screening, committed, sim.currentUnix, ghostCrashEvents(ghosts, sim.currentUnix));
  const nextDt = next ? next.atUnix - sim.currentUnix : null;
  const nextInk = next && nextDt !== null ? (next.kind === 'burn' ? 'text-burn' : next.kind === 'ghost' || next.critical || nextDt < 900 ? 'text-threat' : 'text-tracked') : 'text-dim';
  const status = dataStall
    ? { text: 'Buffering orbit data', tone: 'text-warn' }
    : autoSlow
      ? { text: autoSlow.kind === 'burn' ? 'Slow motion: dodge burn' : autoSlow.kind === 'ghost' ? 'Slow motion: ghost collision' : 'Slow motion: close pass', tone: autoSlow.kind === 'burn' ? 'text-burn' : autoSlow.kind === 'ghost' ? 'text-threat' : 'text-tracked' }
      : null;

  return (
    <div className="hud pointer-events-auto px-3 pb-2 pt-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => controller.toggle()}
            disabled={disabled}
            aria-label={sim.playing ? 'Pause the simulation' : 'Resume the simulation'}
            title={sim.playing ? 'Pause (Space)' : 'Resume (Space)'}
            className={`flex h-[36px] w-[36px] items-center justify-center rounded-md border transition-[background-color,border-color,transform] duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.95] disabled:opacity-40 motion-reduce:active:scale-100 ${
              sim.playing ? 'border-line-strong bg-panel-2 text-text hover:border-muted' : 'border-primary bg-primary text-bg hover:bg-primary-hover'
            }`}
          >
            <PlayIcon playing={sim.playing} />
          </button>
          <label className="sr-only" htmlFor="sandbox-speed">Simulation speed</label>
          <select id="sandbox-speed" value={sim.speed} onChange={(e) => setSpeed(Number(e.target.value))} disabled={disabled} className="hud-select mono h-[36px] text-[12px]" title="How many simulated seconds pass each second">
            {SPEED_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v}×
              </option>
            ))}
          </select>
        </div>

        <div className="flex min-w-0 flex-col">
          {/* only the state is a live region: the clock itself ticks every frame */}
          <span role="status" className={`flex items-center gap-1.5 whitespace-nowrap text-[10px] ${status ? status.tone : 'text-dim'}`}>
            <i aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${status ? 'pulse bg-current' : sim.playing ? 'pulse bg-safe' : 'bg-dim'}`} />
            {status ? status.text : sim.playing ? 'Live' : 'Paused'}
          </span>
          <span className="mono text-[13px] leading-5 text-text">{formatUtc(sim.currentUnix, false)}</span>
        </div>

        <div className="hidden min-w-0 flex-1 basis-40 flex-col sm:flex">
          <span className="text-[10px] text-dim">Next event</span>
          {next && nextDt !== null ? (
            <span className={`truncate text-[12px] leading-5 ${nextInk}`}>
              <span className="mono">{formatCountdown(nextDt)}</span>{' '}
              <span className="text-text" aria-live="polite">
                {next.label}
              </span>
            </span>
          ) : (
            <span className="truncate text-[12px] leading-5 text-muted">Nothing ahead. Drop some junk to give the autopilot work.</span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <label className="flex min-h-[32px] cursor-pointer items-center gap-1.5 text-[11px] text-muted hover:text-text" title="Draw the line the spacecraft flies along, and the ghosts' courses">
            <input type="checkbox" role="switch" className="switch" checked={showPath} onChange={() => toggleLayer('original')} />
            Path
          </label>
          <label className="flex min-h-[32px] cursor-pointer items-center gap-1.5 text-[11px] text-muted hover:text-text" title="Drop to 1× around each closest approach so the pass is watchable in the close-up">
            <input type="checkbox" role="switch" className="switch" checked={slowForPasses} onChange={(e) => setSlowForPasses(e.target.checked)} />
            Slow for passes
          </label>
        </div>
      </div>
      <div className="mt-2.5">
        <LookAheadRail nowUnix={sim.currentUnix} />
      </div>
    </div>
  );
}
