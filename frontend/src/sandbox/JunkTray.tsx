import { Badge, Button } from '../components/ui';
import { JUNK_KINDS } from './junkKinds';
import { useAppStore } from '../store/useAppStore';

/**
 * The sandbox's junk tray: how much debris is in orbit, and controls to spawn a random mix of a chosen
 * size or take the most recent pieces away. The backend builds each piece so its closest approach falls
 * in its kind's distance band; the autopilot then screens it, plans a burn and flies it.
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
  if (!enabled) return null;
  const room = Math.max(0, maxObjects - spawned);
  const busy = spawnInFlight || scenarioLoading;

  return (
    <details open className="pointer-events-auto w-[300px] rounded border border-line bg-panel/85 p-3 backdrop-blur">
      <summary className="flex cursor-pointer select-none items-center justify-between text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">
        <span>Space junk</span>
        <span className="flex items-center gap-1.5 normal-case tracking-normal">
          {evaluateInFlight && <Badge tone="info">autopilot thinking…</Badge>}
          <Badge tone={autopilot ? 'safe' : 'warn'}>{autopilot ? 'autopilot on' : 'needs approval'}</Badge>
        </span>
      </summary>
      <div className="mt-2 flex items-end gap-4">
        <div>
          <div className="text-[9px] uppercase tracking-wider text-dim">Debris in orbit</div>
          <div className="mono text-2xl leading-none text-text" aria-live="polite">
            {spawned}
            <span className="text-xs text-dim"> / {maxObjects}</span>
          </div>
        </div>
        <div className="text-[10px] leading-snug text-muted">
          <div>
            <span className="mono text-text">{threats}</span> {threats === 1 ? 'pass needs' : 'passes need'} a dodge
          </div>
          <div>
            <span className="mono text-text">{committed}</span> burn{committed === 1 ? '' : 's'} committed
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <label htmlFor="junk-random-count" className="text-[10px] uppercase tracking-wider text-muted">
          Pieces
        </label>
        <input
          id="junk-random-count"
          type="number"
          min={1}
          max={20}
          value={randomCount}
          onChange={(e) => setRandomCount(Number(e.target.value))}
          className="w-12 rounded border border-line-strong bg-panel-2 px-1.5 py-1 text-[11px] text-text"
        />
        <Button size="sm" variant="primary" loading={spawnInFlight} disabled={busy || room === 0} onClick={() => void spawnRandom(Math.min(randomCount, room))} title="Spawn a mix of fragments, rocket bodies and dead satellites with passes spread over the next two orbits">
          Spawn
        </Button>
        <Button size="sm" variant="danger" disabled={busy || spawned === 0} onClick={() => void removeJunk(Math.min(randomCount, spawned))} title="Take the most recently spawned pieces out of orbit (burns already flown for them stay)">
          Remove
        </Button>
      </div>
      <ul className="mt-2 space-y-0.5 text-[10px] text-dim">
        {JUNK_KINDS.map((k) => (
          <li key={k.kind} className="flex items-center gap-1.5" title={k.blurb}>
            <i aria-hidden="true" className="inline-block h-2 w-2 rounded-sm" style={{ background: k.swatch }} />
            <span className="text-muted">{k.label}</span>
            <span className="mono ml-auto">
              {k.bandKm[0]}–{k.bandKm[1]} km
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[10px] leading-snug text-dim">
        Each piece gets at least half an hour of warning; the autopilot screens, plans and flies the dodge. Watch the close-up: drag to look around the spacecraft.
      </p>
      {room === 0 && <p className="mt-1 text-[10px] text-warn">The sandbox is full: remove some junk or reset the scenario.</p>}
    </details>
  );
}
