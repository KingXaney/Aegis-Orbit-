import '@fontsource/b612/400.css';
import '@fontsource/b612/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/barlow-condensed/600.css';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import GlobeView from './globe/GlobeView';
import ClockControls from './panels/ClockControls';
import JunkTray from './sandbox/JunkTray';
import { startLiveLoop } from './simulation/liveLoop';
import LayerControls from './panels/LayerControls';
import MissionPanel from './panels/MissionPanel';
import ObjectInspector from './panels/ObjectInspector';
import SatelliteInset from './panels/SatelliteInset';
import DodgeCard from './panels/DodgeCard';
import GhostWarning from './panels/GhostWarning';
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
  const isSandbox = useAppStore((s) => s.scenario?.kind === 'sandbox');
  const insetExpanded = useAppStore((s) => s.insetExpanded);
  // The close-up, the warnings and notices stack above the clock bar, whose height changes with the
  // scenario and the screen width: measure it rather than guess.
  const clockRef = useRef<HTMLDivElement>(null);
  const [clockH, setClockH] = useState(88);
  useEffect(() => {
    const el = clockRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setClockH(Math.round(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV) {
      (window as unknown as { __store?: typeof useAppStore }).__store = useAppStore;
      (window as unknown as { __controller?: typeof controller }).__controller = controller;
    }
    void init();
  }, [init]);

  // rolling orbit data, the sandbox autopilot loop and slow motion around passes ride on the clock
  useEffect(() => startLiveLoop(), []);

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
      <div className={`relative w-full lg:h-full lg:min-h-0 lg:flex-1 ${missionPanelOpen ? 'h-[55vh] min-h-[320px]' : 'min-h-0 flex-1'}`} style={{ '--hud-bottom': `${clockH + 20}px` } as CSSProperties}>
        <div className="absolute inset-0">
          <GlobeView />
        </div>
        {/* before the HUD, so the object inspector stays on top if the two meet */}
        <SatelliteInset className="pointer-events-none absolute bottom-[var(--hud-bottom)] right-3 h-[200px] w-[280px]" expandedClassName="absolute inset-0">
          <GlobeView variant="inset" />
        </SatelliteInset>
        {/* bottom right, above the close-up: the warning before a ghost's collision and the change of course while a dodge burn is near */}
        <div className={`pointer-events-none absolute bottom-[var(--hud-bottom)] right-3 flex w-[280px] max-w-[calc(100%-24px)] flex-col gap-2 ${insetExpanded ? '' : 'md:bottom-[calc(var(--hud-bottom)+208px)]'}`}>
          <GhostWarning className="pointer-events-auto" />
          <DodgeCard className="pointer-events-auto" />
        </div>
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3">
          {/* the expanded close-up is a focus view: the header, junk tray and inspector step aside (hidden, not unmounted) */}
          <div className={`flex flex-wrap items-start justify-between gap-3 ${insetExpanded ? 'invisible' : ''}`}>
            <div className="flex w-full min-w-0 flex-col items-start gap-2 sm:w-auto">
              <TopBar />
              <JunkTray />
            </div>
            <div className="ml-auto flex flex-col items-end gap-2">
              <ObjectInspector />
            </div>
          </div>
          <div className="flex items-end gap-3">
            <div className="hidden md:block">
              <LayerControls />
            </div>
            <div ref={clockRef} className="min-w-0 flex-1">
              {/* the realistic and scripted scenarios keep their timeline; the sandbox clock only pauses and changes speed */}
              {isSandbox ? <ClockControls /> : <TimelineBar />}
            </div>
          </div>
        </div>
        {/* left of the close-up window and above the clock, so it never covers a control */}
        {/* the live region stays mounted so screen readers announce each notice as it arrives */}
        <div role="status" className="pointer-events-none absolute inset-x-3 bottom-[var(--hud-bottom)] z-30 flex justify-center md:right-[304px]">
          {notice && (
            <div key={notice} className="hud hud-in flex max-w-full items-center gap-2 px-3 py-2 text-[12px] text-text">
              <i aria-hidden="true" className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              {notice}
            </div>
          )}
        </div>
        {scenarioLoading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg/40">
            <div role="status" className="hud flex items-center gap-2.5 px-4 py-2.5 text-[12px] text-muted">
              <Spinner className="text-primary" /> Loading orbital data and precomputing trajectories…
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
          className={`z-20 flex shrink-0 items-center justify-center gap-1.5 border-line bg-panel text-[11px] text-muted transition-colors hover:text-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary ${
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
        <div role="alert" className="hud fixed left-1/2 top-3 z-50 flex w-[min(640px,calc(100%-24px))] -translate-x-1/2 items-center gap-3 !border-threat/50 px-4 py-2 text-xs text-threat">
          <span>Backend offline: {backendError}. Start it with <code className="mono">uvicorn app.main:app --reload</code> in <code className="mono">backend/</code>.</span>
          <Button size="sm" variant="danger" onClick={() => void init()}>Retry</Button>
        </div>
      )}
      {backendStatus === 'online' && scenarioError && (
        <div role="alert" className="hud fixed left-1/2 top-3 z-50 flex w-[min(640px,calc(100%-24px))] -translate-x-1/2 items-center gap-3 !border-warn/50 px-4 py-2 text-xs text-warn">
          <span>Scenario failed to load: {scenarioError}</span>
          <Button size="sm" onClick={() => void loadScenario(scenarioId)}>Retry</Button>
        </div>
      )}
    </div>
  );
}
