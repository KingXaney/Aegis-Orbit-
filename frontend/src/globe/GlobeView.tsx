import { useEffect, useRef } from 'react';
import { controller } from '../simulation/controller';
import { useAppStore } from '../store/useAppStore';
import { GlobeScene } from './scene';

/**
 * Hosts the Cesium viewer. The scene manager (plain TypeScript) owns every
 * entity; React effects push store changes into it.
 */
export default function GlobeView({ mini = false }: { mini?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<GlobeScene | null>(null);
  const scenario = useAppStore((s) => s.scenario);
  const objects = useAppStore((s) => s.objects);
  const trajectories = useAppStore((s) => s.trajectories);
  const selectedConjunction = useAppStore((s) => s.selectedConjunction());
  const plan = useAppStore((s) => s.plan);
  const candidateTrajectories = useAppStore((s) => s.candidateTrajectories);
  const selectedManeuverId = useAppStore((s) => s.selectedManeuverId);
  const approvedManeuverId = useAppStore((s) => s.simulation?.approved_maneuver_id ?? null);
  const layers = useAppStore((s) => s.layers);
  const cameraMode = useAppStore((s) => s.cameraMode);
  const cameraResetNonce = useAppStore((s) => s.cameraResetNonce);
  const selectObject = useAppStore((s) => s.selectObject);
  const selectManeuver = useAppStore((s) => s.selectManeuver);
  const setSceneReady = useAppStore((s) => s.setSceneReady);

  useEffect(() => {
    if (!containerRef.current || sceneRef.current) return;
    try {
      const scene = new GlobeScene(
        containerRef.current,
        controller,
        {
          onPick: (kind, id) => {
            if (kind === 'object' && id) selectObject(id);
            else if (kind === 'candidate' && id) selectManeuver(id);
          },
        },
        import.meta.env.VITE_CESIUM_ION_TOKEN || undefined,
      );
      sceneRef.current = scene;
      if (import.meta.env.DEV) (window as unknown as { __globe?: GlobeScene }).__globe = scene;
      setSceneReady(true);
    } catch (err) {
      console.error('Cesium failed to initialise', err);
      setSceneReady(false, (err as Error).message);
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
    const trajList = Object.values(trajectories);
    if (trajList.length === 0) return;
    scene.setScenario(scenario, Object.values(objects), trajList);
    scene.setCameraMode(cameraMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario?.scenario_id, scenario?.simulation.reset_count, trajectories]);

  useEffect(() => {
    sceneRef.current?.setConjunction(selectedConjunction ?? null);
  }, [selectedConjunction]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const candidates = plan ? plan.candidates.filter((c) => plan.recommended_ids.includes(c.maneuver_id) || c.maneuver_id === approvedManeuverId) : [];
    scene.setCandidates(candidates, candidateTrajectories, selectedManeuverId, approvedManeuverId);
  }, [plan, candidateTrajectories, selectedManeuverId, approvedManeuverId]);

  useEffect(() => {
    sceneRef.current?.setLayers(layers);
  }, [layers]);

  useEffect(() => {
    sceneRef.current?.setCameraMode(cameraMode);
  }, [cameraMode]);

  useEffect(() => {
    if (cameraResetNonce > 0) sceneRef.current?.resetCamera();
  }, [cameraResetNonce]);

  useEffect(() => {
    sceneRef.current?.setMiniMode(mini);
  }, [mini]);

  return <div ref={containerRef} className="absolute inset-0" aria-label="3D orbital simulation" />;
}
