import { useEffect, useMemo, useRef, useState } from 'react';
import { controller } from '../simulation/controller';
import { useAppStore } from '../store/useAppStore';
import { buildEncounters } from './encounters';
import { EncounterScene } from './scene';
import EncounterLegend from './EncounterLegend';

/**
 * Waymo-style local view. The scene manager owns every Three.js object; React
 * effects push store changes into it, exactly like GlobeView does for Cesium.
 */
export default function EncounterView({ mini = false }: { mini?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<EncounterScene | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scenario = useAppStore((s) => s.scenario);
  const objects = useAppStore((s) => s.objects);
  const trajectories = useAppStore((s) => s.trajectories);
  const encounterTrajectories = useAppStore((s) => s.encounterTrajectories);
  const perception = useAppStore((s) => s.perception);
  const perceptionManeuvered = useAppStore((s) => s.perceptionManeuvered);
  const perceptionError = useAppStore((s) => s.perceptionError);
  const screening = useAppStore((s) => s.screening);
  const selectedManeuver = useAppStore((s) => s.selectedManeuver());
  const candidateTrajectories = useAppStore((s) => s.candidateTrajectories);
  const approvedManeuverId = useAppStore((s) => s.simulation?.approved_maneuver_id ?? null);
  const selectedConjunctionId = useAppStore((s) => s.selectedConjunctionId);
  const selectedObjectId = useAppStore((s) => s.selectedObjectId);
  const layers = useAppStore((s) => s.layers);
  const mode = useAppStore((s) => s.encounterMode);
  const resetNonce = useAppStore((s) => s.encounterCameraResetNonce);
  const selectEncounter = useAppStore((s) => s.selectEncounter);
  const showLegend = useAppStore((s) => s.showLegend);

  const built = useMemo(
    () => buildEncounters({ perception, perceptionManeuvered, screening, objects, scenario }),
    [perception, perceptionManeuvered, screening, objects, scenario],
  );

  useEffect(() => {
    if (!containerRef.current || sceneRef.current) return;
    try {
      const scene = new EncounterScene(containerRef.current, controller, {
        onPick: (objectId, conjunctionId) => selectEncounter(objectId, conjunctionId),
        onError: (msg) => setError(msg),
      });
      sceneRef.current = scene;
      if (import.meta.env.DEV) (window as unknown as { __encounter?: EncounterScene }).__encounter = scene;
    } catch (err) {
      setError((err as Error).message);
    }
    return () => {
      sceneRef.current?.destroy();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !scenario) return;
    const all = { ...trajectories, ...encounterTrajectories };
    scene.setScenario(scenario, Object.values(objects), Object.values(all));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario?.scenario_id, scenario?.simulation.reset_count, trajectories, encounterTrajectories]);

  useEffect(() => {
    sceneRef.current?.setEncounters(built.items, built.thresholds);
  }, [built]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const approved = approvedManeuverId ? candidateTrajectories[approvedManeuverId] ?? null : null;
    if (approvedManeuverId && approved) {
      const m = useAppStore.getState().plan?.candidates.find((c) => c.maneuver_id === approvedManeuverId) ?? useAppStore.getState().simulation?.approved_maneuver ?? null;
      scene.setManeuver(m, approved, true);
      return;
    }
    scene.setManeuver(selectedManeuver, selectedManeuver ? candidateTrajectories[selectedManeuver.maneuver_id] ?? null : null, false);
  }, [selectedManeuver, candidateTrajectories, approvedManeuverId]);

  useEffect(() => {
    sceneRef.current?.setSelection(selectedObjectId, selectedConjunctionId);
  }, [selectedObjectId, selectedConjunctionId]);

  useEffect(() => {
    sceneRef.current?.setLayers(layers);
  }, [layers]);

  useEffect(() => {
    sceneRef.current?.setMode(mode);
  }, [mode]);

  useEffect(() => {
    if (resetNonce > 0) sceneRef.current?.resetCamera();
  }, [resetNonce]);

  useEffect(() => {
    sceneRef.current?.setMiniMode(mini);
  }, [mini]);

  return (
    <div className="absolute inset-0 overflow-hidden bg-bg">
      <div ref={containerRef} className="absolute inset-0" aria-label="Encounter view" />
      <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(ellipse at center, transparent 55%, rgba(5,8,15,0.65) 100%)' }} />
      {!mini && showLegend && <EncounterLegend mode={mode} thresholds={built.thresholds} basis={built.basis} count={built.items.length} />}
      {!mini && perceptionError && (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded border border-warn/50 bg-panel/90 px-2 py-1 text-[10px] text-warn">
          perception unavailable — showing screening results
        </div>
      )}
      {error && <div className="absolute inset-0 flex items-center justify-center bg-bg/80 p-6 text-center text-xs text-threat">{error}</div>}
    </div>
  );
}
