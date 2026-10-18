import { useAppStore } from '../store/useAppStore';
import { Button, Toggle } from '../components/ui';

export default function LayerControls() {
  const layers = useAppStore((s) => s.layers);
  const toggleLayer = useAppStore((s) => s.toggleLayer);
  const resetCamera = useAppStore((s) => s.resetCamera);
  const cameraMode = useAppStore((s) => s.cameraMode);
  const setCameraMode = useAppStore((s) => s.setCameraMode);
  const scenario = useAppStore((s) => s.scenario);

  return (
    <details className="pointer-events-auto w-[230px] rounded border border-line bg-panel/85 p-3 backdrop-blur xl:w-[300px]">
      <summary className="cursor-pointer select-none text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">Globe camera &amp; layers</summary>
      <div className="mb-2 mt-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">Camera</div>
      <div className="mb-1.5 flex gap-1.5">
        <Button size="sm" variant={cameraMode === 'world' ? 'primary' : 'secondary'} onClick={() => setCameraMode('world')} title="Look around the Earth as it turns beneath the orbit">
          World
        </Button>
        <Button size="sm" variant={cameraMode === 'follow' ? 'primary' : 'secondary'} onClick={() => setCameraMode('follow')} title="Ride with the spacecraft, close enough to see its model">
          Follow
        </Button>
        <Button size="sm" variant="ghost" onClick={resetCamera} title="Back to this view's default framing">
          Reset
        </Button>
      </div>
      <p className="mb-3 text-[10px] leading-snug text-dim">
        {cameraMode === 'world'
          ? 'The camera stays still in space while the Earth turns under the orbit. Drag to look around the Earth, scroll to zoom.'
          : 'The camera rides behind and above the spacecraft, in its orbit plane, so the path ahead reads as one line. Drag to look around it, scroll to zoom out for orbit context.'}
      </p>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">Layers</div>
      <div className="grid grid-cols-1 gap-1">
        <Toggle label="Planned & original path" checked={layers.original} onChange={() => toggleLayer('original')} swatch="#2dd4bf" />
        <Toggle label="Threat object path" checked={layers.secondary} onChange={() => toggleLayer('secondary')} swatch="#f87171" />
        <Toggle label="Candidate maneuvers" checked={layers.candidates} onChange={() => toggleLayer('candidates')} swatch="#4ade80" />
        <Toggle label="TCA markers & danger region" checked={layers.markers} onChange={() => toggleLayer('markers')} swatch="#ef4444" />
        <Toggle label="Detection radius (25 / 5 km)" checked={layers.detection} onChange={() => toggleLayer('detection')} swatch="#67e8f9" />
        <Toggle label="Tracked objects" checked={layers.background} onChange={() => toggleLayer('background')} swatch="#93c5fd" />
        <Toggle label="Tracked object orbits" checked={layers.backgroundOrbits} onChange={() => toggleLayer('backgroundOrbits')} />
        <Toggle label="Labels" checked={layers.labels} onChange={() => toggleLayer('labels')} />
      </div>
      <p className="mt-3 text-[10px] leading-snug text-dim">
        Spacecraft models are true scale (Follow gets close enough to see them); markers and the danger region are enlarged for visibility. The teal band is the path the spacecraft will fly; dashed cyan is the original path kept for comparison after an approved burn; green bands are candidate burns; dim solid trails are past motion.
        {scenario?.kind === 'real'
          ? ' Positions are SGP4 estimates from public elements, not sensor telemetry.'
          : scenario?.kind === 'sandbox'
            ? ' States are synthetic. Spawned junk within 30 km of the spacecraft is drawn enlarged so it can be seen; its label gives the true size and distance.'
            : ' States are synthetic.'}
      </p>
    </details>
  );
}
