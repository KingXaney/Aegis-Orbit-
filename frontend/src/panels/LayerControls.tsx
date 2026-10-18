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
    <details className="hud pointer-events-auto w-[230px] px-3 py-2 xl:w-[300px]">
      <summary className="flex min-h-8 cursor-pointer select-none items-center rounded-md text-[12px] text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-primary">Camera &amp; layers</summary>
      <h3 className="display mb-1.5 mt-2 text-[14px] text-text">Camera</h3>
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
      <h3 className="display mb-1 text-[14px] text-text">Layers</h3>
      <div className="grid grid-cols-1 gap-1">
        <Toggle label="Planned path & ghost courses" checked={layers.original} onChange={() => toggleLayer('original')} swatch="#2dd4bf" />
        <Toggle label="Threat object path" checked={layers.secondary} onChange={() => toggleLayer('secondary')} swatch="#f87171" />
        <Toggle label="Candidate maneuvers" checked={layers.candidates} onChange={() => toggleLayer('candidates')} swatch="#4ade80" />
        <Toggle label="TCA markers & danger region" checked={layers.markers} onChange={() => toggleLayer('markers')} swatch="#ef4444" />
        <Toggle label="Detection radius (25 / 5 km)" checked={layers.detection} onChange={() => toggleLayer('detection')} swatch="#67e8f9" />
        <Toggle label="Tracked objects" checked={layers.background} onChange={() => toggleLayer('background')} swatch="#93c5fd" />
        <Toggle label="Tracked object orbits" checked={layers.backgroundOrbits} onChange={() => toggleLayer('backgroundOrbits')} />
        <Toggle label="Labels" checked={layers.labels} onChange={() => toggleLayer('labels')} />
      </div>
      <p className="mt-3 text-[10px] leading-snug text-dim">
        Spacecraft models are true scale (Follow gets close enough to see them); markers and the danger region are enlarged for visibility. The teal band is the path the spacecraft will fly; dashed cyan is a ghost's course, the path not taken after a committed burn, flown by a translucent ghost until the pass the burn avoided; green bands are candidate burns; dim solid trails are past motion.
        {scenario?.kind === 'real'
          ? ' Positions are SGP4 estimates from public elements, not sensor telemetry.'
          : scenario?.kind === 'sandbox'
            ? ' States are synthetic. Spawned junk within 30 km of the spacecraft is drawn enlarged so it can be seen; its label gives the true size and distance.'
            : ' States are synthetic.'}
      </p>
    </details>
  );
}
