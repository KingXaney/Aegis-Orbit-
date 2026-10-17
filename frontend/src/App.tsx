import { useEffect } from 'react';
import GlobeView from './globe/GlobeView';
import EncounterView from './encounter/EncounterView';
import EncounterControls from './encounter/EncounterControls';
import LayerControls from './panels/LayerControls';
import MissionPanel from './panels/MissionPanel';
import ObjectInspector from './panels/ObjectInspector';
import TimelineBar from './panels/TimelineBar';
import TopBar from './panels/TopBar';
import { controller } from './simulation/controller';
import { useAppStore } from './store/useAppStore';
import { Button, Spinner, ViewFrame } from './components/ui';

const STAGE = 'absolute inset-0';
const MINI = 'absolute bottom-[92px] left-3 z-10 hidden h-[210px] w-[300px] overflow-hidden rounded border border-line bg-bg shadow-lg md:block';

export default function App() {
  const init = useAppStore((s) => s.init);
  const backendStatus = useAppStore((s) => s.backendStatus);
  const backendError = useAppStore((s) => s.backendError);
  const scenarioLoading = useAppStore((s) => s.scenarioLoading);
  const scenarioError = useAppStore((s) => s.scenarioError);
  const sceneError = useAppStore((s) => s.sceneError);
  const notice = useAppStore((s) => s.notice);
  const dismissNotice = useAppStore((s) => s.dismissNotice);
  const loadScenario = useAppStore((s) => s.loadScenario);
  const scenarioId = useAppStore((s) => s.scenarioId);
  const mainView = useAppStore((s) => s.mainView);
  const swapMainView = useAppStore((s) => s.swapMainView);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
      if (e.code === 'Space') {
        e.preventDefault();
        controller.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    // Chase mode: hold 1x speed within two minutes of the critical closest approach so the pass is watchable.
    let restore: number | null = null;
    const unsub = controller.subscribe((st) => {
      const { encounterMode, autoSlowNearTca, perception, screening } = useAppStore.getState();
      if (encounterMode !== 'chase' || !autoSlowNearTca) return;
      const critical = perception?.objects.find((o) => o.tier === 'CRITICAL' && o.physics.tca_unix !== null)?.physics.tca_unix
        ?? screening?.conjunctions.find((c) => c.threat_state === 'CRITICAL')?.tca_unix ?? null;
      if (critical === null) return;
      const near = Math.abs(critical - st.currentUnix) < 120;
      if (near && st.playing && st.speed > 1) {
        restore = st.speed;
        controller.setSpeed(1);
      } else if (!near && restore !== null && st.speed === 1) {
        controller.setSpeed(restore);
        restore = null;
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(dismissNotice, 5000);
    return () => clearTimeout(t);
  }, [notice, dismissNotice]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg lg:flex-row">
      <div className="relative h-[55vh] min-h-[320px] w-full lg:h-full lg:min-h-0 lg:flex-1">
        <div className={mainView === 'encounter' ? STAGE : MINI}>
          <ViewFrame mini={mainView !== 'encounter'} label="Encounter" onSwap={swapMainView}>
            <EncounterView mini={mainView !== 'encounter'} />
          </ViewFrame>
        </div>
        <div className={mainView === 'globe' ? STAGE : MINI}>
          <ViewFrame mini={mainView !== 'globe'} label="Globe" onSwap={swapMainView}>
            <GlobeView mini={mainView !== 'globe'} />
          </ViewFrame>
        </div>
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3">
          <div className="flex items-start justify-between gap-3">
            <TopBar />
            <div className="flex flex-col items-end gap-2">
              <EncounterControls />
              <ObjectInspector />
            </div>
          </div>
          <div className="flex items-end gap-3">
            <div className="hidden md:block">
              <LayerControls />
            </div>
            <div className="min-w-0 flex-1">
              <TimelineBar />
            </div>
          </div>
        </div>
        {scenarioLoading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg/40">
            <div className="flex items-center gap-2 rounded border border-line bg-panel/90 px-4 py-2 text-xs text-muted">
              <Spinner /> Loading orbital data and precomputing trajectories…
            </div>
          </div>
        )}
        {sceneError && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg/80 p-6 text-center text-xs text-threat">
            The 3D view could not start (WebGL unavailable?): {sceneError}
          </div>
        )}
      </div>
      <div className="h-[45vh] w-full lg:h-full lg:w-[400px] lg:shrink-0">
        <MissionPanel />
      </div>

      {backendStatus === 'offline' && (
        <div className="fixed left-1/2 top-3 z-50 flex -translate-x-1/2 items-center gap-3 rounded border border-threat/50 bg-panel px-4 py-2 text-xs text-threat shadow-lg">
          <span>Backend offline: {backendError}. Start it with <code className="mono">uvicorn app.main:app --reload</code> in <code className="mono">backend/</code>.</span>
          <Button size="sm" variant="danger" onClick={() => void init()}>Retry</Button>
        </div>
      )}
      {backendStatus === 'online' && scenarioError && (
        <div className="fixed left-1/2 top-3 z-50 flex -translate-x-1/2 items-center gap-3 rounded border border-warn/50 bg-panel px-4 py-2 text-xs text-warn shadow-lg">
          <span>Scenario failed to load: {scenarioError}</span>
          <Button size="sm" onClick={() => void loadScenario(scenarioId)}>Retry</Button>
        </div>
      )}
      {notice && (
        <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded border border-line bg-panel px-3 py-1.5 text-xs text-muted shadow-lg" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}
