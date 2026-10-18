import { useId, useState } from 'react';
import { Button, Spinner } from '../components/ui';
import { JUNK_KINDS } from './junkKinds';
import { useAppStore } from '../store/useAppStore';

const MAX_PER_SPAWN = 20;
// open by default where there is room beside the globe; folded to its header on phones
const startsOpen = () => typeof window === 'undefined' || window.matchMedia('(min-width: 768px)').matches;

function StepButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled: boolean; children: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-full w-[32px] items-center justify-center text-[16px] leading-none text-muted transition-colors hover:text-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/**
 * The sandbox's junk tray: how much debris is in orbit, and controls to spawn a random mix or take the
 * most recent pieces away. The backend builds each piece so its closest approach falls in its kind's
 * distance band; the autopilot then screens it, plans a burn and flies it.
 */
export default function JunkTray() {
  const enabled = useAppStore((s) => s.sandbox.enabled);
  const randomCount = useAppStore((s) => s.sandbox.randomCount);
  const spawnInFlight = useAppStore((s) => s.sandbox.spawnInFlight);
  const evaluateInFlight = useAppStore((s) => s.sandbox.evaluateInFlight);
  const autopilot = useAppStore((s) => s.sandbox.autopilot);
  const spawned = useAppStore((s) => s.sandbox.spawnedIds.length);
  const maxObjects = useAppStore((s) => s.sandbox.junkTypes?.max_objects ?? 25);
  const committed = useAppStore((s) => s.simulation?.committed_maneuvers.length ?? 0);
  const threats = useAppStore((s) => (s.screening?.conjunctions ?? []).filter((c) => c.threat_state === 'CRITICAL' || c.threat_state === 'ELEVATED').length);
  const scenarioLoading = useAppStore((s) => s.scenarioLoading);
  const spawnRandom = useAppStore((s) => s.spawnRandom);
  const removeJunk = useAppStore((s) => s.removeJunk);
  const setRandomCount = useAppStore((s) => s.setRandomCount);
  const setAutopilot = useAppStore((s) => s.setAutopilot);
  const [open, setOpen] = useState(startsOpen);
  // the switch moves on click; the store follows when the backend answers (and snaps back if it fails)
  const [wantAutopilot, setWantAutopilot] = useState<boolean | null>(null);
  const autopilotShown = wantAutopilot ?? autopilot;
  const toggleAutopilot = () => {
    const next = !autopilotShown;
    setWantAutopilot(next);
    void setAutopilot(next).finally(() => setWantAutopilot(null));
  };
  const bodyId = useId();
  if (!enabled) return null;
  const room = Math.max(0, maxObjects - spawned);
  const busy = spawnInFlight || scenarioLoading;
  const toSpawn = Math.min(randomCount, room);
  const toRemove = Math.min(randomCount, spawned);

  return (
    <section aria-label="Space junk" className="hud pointer-events-auto w-full sm:w-[300px]">
      <header className="flex items-center justify-between gap-2 py-1.5 pl-1.5 pr-3">
        <h2 className="min-w-0">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={bodyId}
            className="flex min-h-[36px] min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 text-left hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-primary"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform duration-200 ease-out motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}>
              <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="display whitespace-nowrap text-[17px] leading-6 text-text">Space junk</span>
            {!open && (
              <span className="mono truncate text-[11px] text-muted">
                {spawned}/{maxObjects}
                {threats > 0 && <span className="text-threat"> · {threats} to dodge</span>}
              </span>
            )}
          </button>
        </h2>
        <label className="flex min-h-[36px] cursor-pointer items-center gap-2 text-[11px] text-muted hover:text-text" title={autopilotShown ? 'The autopilot plans and flies every dodge' : 'Planned burns wait for your approval in the mission panel'}>
          Autopilot
          <input type="checkbox" role="switch" className="switch" checked={autopilotShown} aria-busy={wantAutopilot !== null} onChange={toggleAutopilot} />
        </label>
      </header>

      {open && (
        <div id={bodyId} className="px-3 pb-3">
          <div className="flex items-end justify-between gap-3">
            <p className="flex items-baseline gap-1.5" aria-live="polite">
              <span className="display text-[34px] leading-8 text-text tabular-nums">{spawned}</span>
              <span className="text-[11px] text-muted">of {maxObjects} in orbit</span>
            </p>
            <dl className="text-right text-[11px] leading-[18px]">
              <div className={threats > 0 ? 'text-threat' : 'text-muted'}>
                <dt className="sr-only">Passes needing a dodge</dt>
                <dd>
                  <span className="mono">{threats}</span> {threats === 1 ? 'pass needs' : 'passes need'} a dodge
                </dd>
              </div>
              <div className="text-muted">
                <dt className="sr-only">Burns committed</dt>
                <dd>
                  <span className="mono text-burn">{committed}</span> burn{committed === 1 ? '' : 's'} committed
                </dd>
              </div>
            </dl>
          </div>

          {/* one cell per piece the sandbox can hold */}
          <div aria-hidden="true" className="mt-2 flex gap-[2px]">
            {Array.from({ length: maxObjects }, (_, i) => (
              <i key={i} className={`block h-1.5 flex-1 rounded-[1px] transition-colors duration-300 ${i < spawned ? 'bg-text/80' : 'bg-line'}`} />
            ))}
          </div>

          <ul className="mt-3 space-y-1 text-[11px]">
            {JUNK_KINDS.map((k) => (
              <li key={k.kind} className="flex items-center gap-2" title={k.blurb}>
                <i aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ background: k.swatch }} />
                <span className="text-text">{k.label}</span>
                <span className="mono ml-auto text-dim">
                  passes at {k.bandKm[0]}–{k.bandKm[1]} km
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-3 flex items-stretch gap-2">
            <div className="flex h-[40px] items-stretch overflow-hidden rounded-md border border-line-strong bg-bg focus-within:border-muted">
              <StepButton label="One fewer piece" onClick={() => setRandomCount(randomCount - 1)} disabled={randomCount <= 1}>
                −
              </StepButton>
              <label htmlFor="junk-random-count" className="sr-only">
                Pieces per spawn
              </label>
              <input
                id="junk-random-count"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_PER_SPAWN}
                value={randomCount}
                onChange={(e) => setRandomCount(Number(e.target.value))}
                className="mono w-[32px] bg-transparent text-center text-[14px] text-text [appearance:textfield] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <StepButton label="One more piece" onClick={() => setRandomCount(randomCount + 1)} disabled={randomCount >= MAX_PER_SPAWN}>
                +
              </StepButton>
            </div>
            <Button
              variant="solid"
              size="lg"
              className="flex-1"
              loading={spawnInFlight}
              disabled={busy || room === 0}
              onClick={() => void spawnRandom(toSpawn)}
              title="Spawn a mix of fragments, rocket bodies and dead satellites with passes spread over the next two orbits"
            >
              {room === 0 ? 'Sandbox full' : `Spawn ${toSpawn} ${toSpawn === 1 ? 'piece' : 'pieces'}`}
            </Button>
          </div>

          <div className="mt-1.5 flex min-h-7 items-center justify-between gap-2">
            <Button variant="ghost" size="sm" className="-ml-2 hover:text-threat" disabled={busy || spawned === 0} onClick={() => void removeJunk(toRemove)} title="Take the most recently spawned pieces out of orbit (burns already flown for them stay)">
              Remove last {Math.max(1, toRemove)}
            </Button>
            {evaluateInFlight && (
              <span role="status" className="flex items-center gap-1.5 text-[11px] text-muted">
                <Spinner /> Autopilot screening
              </span>
            )}
          </div>

          <p className="mt-1 text-[11px] leading-[17px] text-dim [text-wrap:pretty]">
            {room === 0 ? (
              <span className="text-warn">The sandbox is full. Remove some junk or reset the scenario.</span>
            ) : autopilot ? (
              'Every piece gives at least half an hour of warning. The autopilot screens it, plans a dodge and flies it.'
            ) : (
              'Autopilot is off: planned burns wait for your approval under Human decision in the mission panel.'
            )}
          </p>
        </div>
      )}
    </section>
  );
}
