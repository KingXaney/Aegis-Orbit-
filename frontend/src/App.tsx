import { useEffect } from 'react';
import GlobeView from './globe/GlobeView';
import LayerControls from './panels/LayerControls';
import MissionPanel from './panels/MissionPanel';
import ObjectInspector from './panels/ObjectInspector';
import TimelineBar from './panels/TimelineBar';
import TopBar from './panels/TopBar';
import { controller } from './simulation/controller';
import { useAppStore } from './store/useAppStore';
import { Button, Spinner } from './components/ui';

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
  const missionPanelOpen = useAppStore((s) => s.missionPanelOpen);
  const toggleMissionPanel = useAppStore((s) => s.toggleMissionPanel);

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
    if (!notice) return;
    const t = setTimeout(dismissNotice, 5000);
    return () => clearTimeout(t);
  }, [notice, dismissNotice]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg lg:flex-row">
      <div className={`relative w-full lg:h-full lg:min-h-0 lg:flex-1 ${missionPanelOpen ? 'h-[55vh] min-h-[320px]' : 'min-h-0 flex-1'}`}>
        <div className="absolute inset-0">
          <GlobeView />
        </div>
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <TopBar />
            <div className="ml-auto flex flex-col items-end gap-2">
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
      <div className={missionPanelOpen ? 'relative flex h-[45vh] w-full flex-col lg:h-full lg:w-[400px] lg:shrink-0' : 'relative h-7 w-full lg:h-full lg:w-7 lg:shrink-0'}>
        {/* Collapse handle: a bar above the panel on small screens, a tab on its left edge on wide ones. */}
        <button
          type="button"
          onClick={toggleMissionPanel}
          aria-expanded={missionPanelOpen}
          aria-controls="mission-panel"
          aria-label={missionPanelOpen ? 'Hide the mission panel' : 'Show the mission panel'}
          title={missionPanelOpen ? 'Hide the mission panel' : 'Show the mission panel'}
          className={`z-20 flex shrink-0 items-center justify-center gap-1.5 border-line bg-panel text-[10px] uppercase tracking-[0.18em] text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-primary ${
            missionPanelOpen
              ? 'relative h-7 w-full border-b lg:absolute lg:left-0 lg:top-1/2 lg:h-16 lg:w-6 lg:-translate-x-full lg:-translate-y-1/2 lg:flex-col lg:rounded-l lg:border lg:border-r-0'
              : 'h-full w-full border-b lg:flex-col lg:border-b-0 lg:border-l'
          }`}
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className={`h-3.5 w-3.5 ${missionPanelOpen ? 'rotate-90 lg:rotate-0' : '-rotate-90 lg:rotate-180'}`}>
            <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className={missionPanelOpen ? 'lg:sr-only' : 'lg:[writing-mode:vertical-rl]'}>{missionPanelOpen ? 'Hide panel' : 'Mission panel'}</span>
        </button>
        <div id="mission-panel" className={missionPanelOpen ? 'min-h-0 flex-1' : 'hidden'}>
          <MissionPanel />
        </div>
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
