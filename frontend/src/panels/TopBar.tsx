import { useAppStore } from '../store/useAppStore';
import { Badge, Button, Spinner, ThreatBadge } from '../components/ui';
import { formatUtc } from '../lib/format';
import type { ScenarioKind } from '../types/api';

// Home A / B / C in the scenario menu: the real ISS flow, the scripted synthetic conjunction, the live sandbox.
const SCENARIO_LETTER: Record<ScenarioKind, string> = { real: 'A', synthetic: 'B', sandbox: 'C' };
const KIND_BADGE: Record<ScenarioKind, string> = { real: 'real GP data', synthetic: 'synthetic', sandbox: 'sandbox · live' };

export default function TopBar() {
  const scenarios = useAppStore((s) => s.scenarios);
  const scenarioId = useAppStore((s) => s.scenarioId);
  const scenario = useAppStore((s) => s.scenario);
  const loading = useAppStore((s) => s.scenarioLoading);
  const loadScenario = useAppStore((s) => s.loadScenario);
  const resetScenario = useAppStore((s) => s.resetScenario);
  const backendStatus = useAppStore((s) => s.backendStatus);
  const health = useAppStore((s) => s.health);
  const simulation = useAppStore((s) => s.simulation);
  const runScreening = useAppStore((s) => s.runScreening);
  const screeningLoading = useAppStore((s) => s.screeningLoading);
  const src = scenario?.data_source as Record<string, string | undefined> | undefined;

  return (
    <div className="pointer-events-auto flex max-w-[640px] flex-col gap-2">
      <div className="flex items-center gap-3 rounded border border-line bg-panel/85 px-3 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: backendStatus === 'online' ? '#4ade80' : backendStatus === 'checking' ? '#fbbf24' : '#f87171' }} title={`backend ${backendStatus}`} />
          <span className="text-xs font-semibold tracking-[0.2em] text-text">AEGIS ORBIT</span>
          <span className="hidden text-[10px] uppercase tracking-wider text-dim sm:inline">collision avoidance simulator</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <a href="/" className="rounded px-1.5 py-1 text-[11px] text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-primary">
            Home
          </a>
          <label className="sr-only" htmlFor="scenario-select">Scenario</label>
          <select
            id="scenario-select"
            value={scenarioId}
            disabled={loading || backendStatus !== 'online'}
            onChange={(e) => void loadScenario(e.target.value)}
            className="rounded border border-line-strong bg-panel-2 px-2 py-1 text-[11px] text-text focus-visible:outline-2 focus-visible:outline-primary"
          >
            {scenarios.length === 0 && <option value={scenarioId}>{scenarioId}</option>}
            {scenarios.map((s) => (
              <option key={s.scenario_id} value={s.scenario_id}>
                {SCENARIO_LETTER[s.kind] ?? '·'} · {s.name}
              </option>
            ))}
          </select>
          <Button variant="primary" size="sm" loading={screeningLoading} disabled={!scenario || loading} onClick={() => void runScreening()}>
            Screen conjunctions
          </Button>
          <Button variant="ghost" size="sm" disabled={!scenario || loading} onClick={() => void resetScenario()} title="Reset scenario to its initial state">
            Reset
          </Button>
        </div>
      </div>
      {scenario && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-line bg-panel/85 px-3 py-1.5 text-[11px] text-muted backdrop-blur">
          <ThreatBadge state={simulation?.overall_threat_state} />
          <Badge tone={scenario.kind === 'real' ? 'info' : scenario.kind === 'sandbox' ? 'safe' : 'neutral'}>{KIND_BADGE[scenario.kind] ?? scenario.kind}</Badge>
          <span className="truncate">
            Primary <span className="mono text-text">{scenario.primary_id}</span> · {scenario.object_count} objects
          </span>
          {scenario.kind === 'real' ? (
            <span className="truncate">elements retrieved {src?.retrieved_at ? formatUtc(src.retrieved_at) : 'unknown'}</span>
          ) : (
            <span className="truncate">epoch {formatUtc(scenario.window.start)}</span>
          )}
          {loading && <Spinner className="text-muted" />}
          {health && !health.gemini_configured && <span className="text-dim">agent: deterministic fallback (no Gemini key)</span>}
        </div>
      )}
    </div>
  );
}
