import { useAppStore } from '../store/useAppStore';
import { Button, Toggle } from '../components/ui';

export default function EncounterControls() {
  const mode = useAppStore((s) => s.encounterMode);
  const setMode = useAppStore((s) => s.setEncounterMode);
  const mainView = useAppStore((s) => s.mainView);
  const swap = useAppStore((s) => s.swapMainView);
  const reset = useAppStore((s) => s.resetEncounterCamera);
  const showLegend = useAppStore((s) => s.showLegend);
  const toggleLegend = useAppStore((s) => s.toggleLegend);
  const autoSlow = useAppStore((s) => s.autoSlowNearTca);
  const setAutoSlow = useAppStore((s) => s.setAutoSlowNearTca);
  const perception = useAppStore((s) => s.perception);
  const loading = useAppStore((s) => s.perceptionLoading);
  return (
    <div className="pointer-events-auto flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1.5 rounded border border-line bg-panel/85 px-2 py-1.5 backdrop-blur">
        <Button size="sm" variant={mode === 'map' ? 'primary' : 'secondary'} onClick={() => setMode('map')} title="Ahead = time to closest approach, sideways = miss offset">
          Encounter map
        </Button>
        <Button size="sm" variant={mode === 'chase' ? 'primary' : 'secondary'} onClick={() => setMode('chase')} title="True-scale chase camera behind the satellite">
          Chase cam
        </Button>
        <Button size="sm" variant="ghost" onClick={reset} title="Reset the encounter camera">
          Reset view
        </Button>
        <Button size="sm" variant="ghost" onClick={swap} title="Swap the main stage and the minimap">
          {mainView === 'encounter' ? 'Show globe' : 'Show encounter'}
        </Button>
      </div>
      <div className="flex items-center gap-3 rounded border border-line bg-panel/85 px-2 py-1 text-[10px] text-muted backdrop-blur">
        <Toggle label="Legend" checked={showLegend} onChange={toggleLegend} />
        <Toggle label="Slow to 1× near TCA (chase)" checked={autoSlow} onChange={() => setAutoSlow(!autoSlow)} />
        <span className="text-dim">
          {loading ? 'perceiving…' : perception ? `model ${perception.model.status === 'LOADED' ? perception.model.library : 'off'} · ${perception.counts.CRITICAL ?? 0} critical / ${perception.counts.SEMI_CRITICAL ?? 0} semi / ${perception.counts.ML_WATCH ?? 0} watch` : 'no perception yet'}
        </span>
      </div>
    </div>
  );
}
