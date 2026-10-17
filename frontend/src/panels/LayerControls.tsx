import { useAppStore } from '../store/useAppStore';
import { Button, Toggle } from '../components/ui';

export default function LayerControls() {
  const layers = useAppStore((s) => s.layers);
  const toggleLayer = useAppStore((s) => s.toggleLayer);
  const cameraMode = useAppStore((s) => s.cameraMode);
  const setCameraMode = useAppStore((s) => s.setCameraMode);
  const resetCamera = useAppStore((s) => s.resetCamera);
  const scenario = useAppStore((s) => s.scenario);

  return (
    <div className="pointer-events-auto w-[230px] rounded border border-line bg-panel/85 p-3 backdrop-blur">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">Camera</div>
      <div className="mb-3 flex gap-1.5">
        <Button size="sm" variant={cameraMode === 'follow' ? 'primary' : 'secondary'} onClick={() => setCameraMode('follow')}>
          Follow
        </Button>
        <Button size="sm" variant={cameraMode === 'free' ? 'primary' : 'secondary'} onClick={() => setCameraMode('free')}>
          Free orbit
        </Button>
        <Button size="sm" variant="ghost" onClick={resetCamera} title="Reset camera">
          Reset
        </Button>
      </div>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">Layers</div>
      <div className="grid grid-cols-1 gap-1">
        <Toggle label="Primary predicted path" checked={layers.original} onChange={() => toggleLayer('original')} swatch="#67e8f9" />
        <Toggle label="Threat object path" checked={layers.secondary} onChange={() => toggleLayer('secondary')} swatch="#f87171" />
        <Toggle label="Candidate maneuvers" checked={layers.candidates} onChange={() => toggleLayer('candidates')} swatch="#4ade80" />
        <Toggle label="TCA markers & danger region" checked={layers.markers} onChange={() => toggleLayer('markers')} swatch="#ef4444" />
        <Toggle label="Tracked objects" checked={layers.background} onChange={() => toggleLayer('background')} swatch="#93c5fd" />
        <Toggle label="Tracked object orbits" checked={layers.backgroundOrbits} onChange={() => toggleLayer('backgroundOrbits')} />
        <Toggle label="Labels" checked={layers.labels} onChange={() => toggleLayer('labels')} />
      </div>
      <p className="mt-3 text-[10px] leading-snug text-dim">
        Markers, the spacecraft model and the danger region are enlarged for visibility. Dashed lines are predicted motion; solid trails are past motion.
        {scenario?.kind === 'real' ? ' Positions are SGP4 estimates from public elements, not sensor telemetry.' : ' States are synthetic.'}
      </p>
    </div>
  );
}
