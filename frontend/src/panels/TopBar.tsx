import { useAppStore } from '../store/useAppStore';
import { Button, Spinner, ThreatBadge } from '../components/ui';
import { formatUtc } from '../lib/format';
import type { ScenarioKind } from '../types/api';

// Home A / B / C in the scenario menu: the real ISS flow, the scripted synthetic conjunction, the live sandbox.
const SCENARIO_LETTER: Record<ScenarioKind, string> = { real: 'A', synthetic: 'B', sandbox: 'C' };
const KIND_LABEL: Record<ScenarioKind, string> = { real: 'Real GP data', synthetic: 'Synthetic', sandbox: 'Live sandbox' };
const STATUS_INK = { online: 'bg-safe', checking: 'bg-warn', offline: 'bg-threat' } as const;

export default function TopBar() {
  const scenarios = useAppStore((s) => s.scenarios);
  const scenarioId = useAppStore((s) => s.scenarioId);
  const scenario = useAppStore((s) => s.scenario);
  const loading = useAppStore((s) => s.scenarioLoading);
  const loadScenario = useAppStore((s) => s.loadScenario);
  const resetScenario = useAppStore((s) => s.resetScenario);
  const backendStatus = useAppStore((s) => s.backendStatus);
  const simulation = useAppStore((s) => s.simulation);
  const runScreening = useAppStore((s) => s.runScreening);
  const screeningLoading = useAppStore((s) => s.screeningLoading);
  const src = scenario?.data_source as Record<string, string | undefined> | undefined;
  // the sandbox's autopilot screens on its own, so a manual screening is a secondary action there
  const sandbox = scenario?.kind === 'sandbox';

  return (
    <header className="hud pointer-events-auto w-full max-w-[640px] px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <a href="/" className="flex min-h-[36px] items-center gap-2 rounded-md px-1.5 hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-primary" title={`Back to the catalog explorer (backend ${backendStatus})`}>
          <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${STATUS_INK[backendStatus]}`} />
          <span className="display whitespace-nowrap text-[17px] leading-6 text-text">Aegis Orbit</span>
          <span className="sr-only">, home. Backend {backendStatus}.</span>
        </a>
        <ThreatBadge state={simulation?.overall_threat_state} />
        <div className="ml-auto flex min-w-0 flex-1 basis-[260px] items-center justify-end gap-1.5">
          <label className="sr-only" htmlFor="scenario-select">Scenario</label>
          <select
            id="scenario-select"
            value={scenarioId}
            disabled={loading || backendStatus !== 'online'}
            onChange={(e) => void loadScenario(e.target.value)}
            className="hud-select h-[32px] min-w-0 max-w-[260px] flex-1 truncate text-[12px]"
          >
            {scenarios.length === 0 && <option value={scenarioId}>{scenarioId}</option>}
            {scenarios.map((s) => (
              <option key={s.scenario_id} value={s.scenario_id}>
                {SCENARIO_LETTER[s.kind] ?? '·'}. {s.name}
              </option>
            ))}
          </select>
          <Button variant={sandbox ? 'secondary' : 'primary'} size="md" loading={screeningLoading} disabled={!scenario || loading} onClick={() => void runScreening()} title="Screen the spacecraft against every object for close approaches">
            {sandbox ? 'Screen now' : 'Screen conjunctions'}
          </Button>
          <Button variant="ghost" size="md" disabled={!scenario || loading} onClick={() => void resetScenario()} title="Reset the scenario to its initial state">
            Reset
          </Button>
        </div>
      </div>
      {scenario && (
        <p className="hidden flex-wrap items-center gap-x-2.5 px-1.5 pb-0.5 pt-1 text-[11px] text-dim sm:flex">
          <span className="text-muted">{KIND_LABEL[scenario.kind] ?? scenario.kind}</span>
          <span>
            Primary <span className="mono text-muted">{scenario.primary_id}</span>
          </span>
          <span>{scenario.object_count} objects</span>
          <span className="hidden sm:inline">
            {scenario.kind === 'real' ? `Elements retrieved ${src?.retrieved_at ? formatUtc(src.retrieved_at) : 'unknown'}` : `Epoch ${formatUtc(scenario.window.start)}`}
          </span>
          {loading && <Spinner className="text-muted" />}
        </p>
      )}
    </header>
  );
}
