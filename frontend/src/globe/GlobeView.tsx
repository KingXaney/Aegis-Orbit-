import { useEffect, useRef } from 'react';
import { controller } from '../simulation/controller';
import { useAppStore } from '../store/useAppStore';
import { GlobeScene } from './scene';

/**
 * Hosts the Cesium viewer. The scene manager (plain TypeScript) owns every
 * entity; React effects push store changes into it. The 'inset' variant is the
 * satellite close-up in the corner: it always follows the spacecraft (drag orbits
 * around it, wheel zooms), shows no labels, and leaves the scene-ready state to
 * the main view.
 */
export default function GlobeView({ variant = 'main' }: { variant?: 'main' | 'inset' }) {
  const inset = variant === 'inset';
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<GlobeScene | null>(null);
  const scenario = useAppStore((s) => s.scenario);
  const objects = useAppStore((s) => s.objects);
  const trajectories = useAppStore((s) => s.trajectories);
  const selectedConjunction = useAppStore((s) => s.selectedConjunction());
  const plan = useAppStore((s) => s.plan);
  const candidateTrajectories = useAppStore((s) => s.candidateTrajectories);
  const selectedManeuverId = useAppStore((s) => s.selectedManeuverId);
  const committed = useAppStore((s) => s.simulation?.committed_maneuvers);
  const ghosts = useAppStore((s) => s.ghosts);
  const insetTarget = useAppStore((s) => s.insetTarget);
  const screening = useAppStore((s) => s.screening);
  const layers = useAppStore((s) => s.layers);
  const cameraResetNonce = useAppStore((s) => s.cameraResetNonce);
  const cameraMode = useAppStore((s) => s.cameraMode);
  const insetZoom = useAppStore((s) => s.insetZoom);
  const insetResetNonce = useAppStore((s) => s.insetResetNonce);
  const selectObject = useAppStore((s) => s.selectObject);
  const selectManeuver = useAppStore((s) => s.selectManeuver);
  const setSceneReady = useAppStore((s) => s.setSceneReady);
  const setBurnFiring = useAppStore((s) => s.setBurnFiring);

  useEffect(() => {
    if (!containerRef.current || sceneRef.current) return;
    try {
      const scene = new GlobeScene(
        containerRef.current,
        controller,
        {
          onPick: (kind, id) => {
            if (inset) return;
            if (kind === 'object' && id) selectObject(id);
            else if (kind === 'candidate' && id) selectManeuver(id);
          },
          onBurnFiring: inset ? undefined : (info) => setBurnFiring(info),
        },
        import.meta.env.VITE_CESIUM_ION_TOKEN || undefined,
        { inset },
      );
      sceneRef.current = scene;
      if (inset) {
        if (import.meta.env.DEV) (window as unknown as { __inset?: GlobeScene }).__inset = scene;
        return () => {
          scene.destroy();
          sceneRef.current = null;
        };
      }
      if (import.meta.env.DEV) (window as unknown as { __globe?: GlobeScene }).__globe = scene;
      setSceneReady(true);
    } catch (err) {
      console.error('Cesium failed to initialise', err);
      if (!inset) setSceneReady(false, (err as Error).message);
    }
    return () => {
      sceneRef.current?.destroy();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A: the scenario itself (also after a reset). B: the objects and their orbit data, whenever the
  // store's records change (rolling data, spawned junk, the committed path after a burn).
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !scenario) return;
    scene.setScenario(scenario);
    scene.setCameraMode(inset ? 'follow' : cameraMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario?.scenario_id, scenario?.simulation.reset_count]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !scenario) return;
    scene.updateTrajectories(trajectories, objects);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario?.scenario_id, scenario?.simulation.reset_count, trajectories, objects]);

  useEffect(() => {
    sceneRef.current?.setConjunction(selectedConjunction ?? null);
  }, [selectedConjunction]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const committedIds = (committed ?? []).map((m) => m.maneuver_id);
    const candidates = plan ? plan.candidates.filter((c) => plan.recommended_ids.includes(c.maneuver_id) || c.maneuver_id === selectedManeuverId) : [];
    scene.setCandidates(candidates, candidateTrajectories, selectedManeuverId, committedIds);
  }, [plan, candidateTrajectories, selectedManeuverId, committed]);

  useEffect(() => {
    sceneRef.current?.setCommittedBurns(committed ?? []);
  }, [committed]);

  // ghosts of the spacecraft (re-applied after a scenario change cleared the viewer)
  useEffect(() => {
    sceneRef.current?.setGhosts(ghosts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghosts, scenario?.scenario_id, scenario?.simulation.reset_count]);

  useEffect(() => {
    if (inset) sceneRef.current?.setTrackTarget(insetTarget);
  }, [insetTarget]);

  useEffect(() => {
    sceneRef.current?.setThreats(screening);
  }, [screening]);

  useEffect(() => {
    // the close-up has its own caption and detection bubble: no labels, no TCA markers (the danger
    // region would sit ahead of the spacecraft there)
    sceneRef.current?.setLayers(inset ? { ...layers, labels: false, markers: false } : layers);
  }, [layers]);

  useEffect(() => {
    if (!inset) sceneRef.current?.setCameraMode(cameraMode);
  }, [cameraMode]);

  useEffect(() => {
    if (!inset && cameraResetNonce > 0) sceneRef.current?.resetCamera();
  }, [cameraResetNonce]);

  useEffect(() => {
    if (inset && insetZoom.nonce > 0) sceneRef.current?.zoomCamera(insetZoom.factor);
  }, [insetZoom]);

  useEffect(() => {
    if (inset && insetResetNonce > 0) sceneRef.current?.resetCamera();
  }, [insetResetNonce]);

  return <div ref={containerRef} className="absolute inset-0" aria-label={inset ? 'Close-up of the satellite' : '3D orbital simulation'} />;
}
