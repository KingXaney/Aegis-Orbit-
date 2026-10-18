import { create } from 'zustand';
import { api } from '../api/client';
import { controller } from '../simulation/controller';
import { isoOf, useAppStore } from '../store/useAppStore';
import type { ScenarioDetail } from '../types/api';
import { perceptionApi } from './api';
import { IDLE, LAST_STEP, STEP, verdictFor } from './funnel';
import type { PerceptionResponse, ShortlistInfo, TleRow } from './types';

// State of the ML perception funnel on the real ISS scenario: the catalog rows the point cloud draws,
// the latest perception response, how far the funnel has played, the operator's decision and the drill.
// It follows the app store's scenario (startPerceptionSync) and writes back to it only to show what the
// funnel reveals: the tracked-objects layer, and the drill's object, trajectory and screening.

/** Real time per funnel step. */
export const STEP_MS = 1100;

export type Decision = { kind: 'stay' | 'maneuver'; atUnix: number };

type ScenarioWithShortlist = ScenarioDetail & { screening_shortlist?: ShortlistInfo | null };

export interface PerceptionState {
  /** The loaded scenario is the full-catalog real one (the funnel exists only there). */
  active: boolean;
  scenarioId: string | null;
  resetCount: number;
  /** Objects with a globe entity of their own: their cloud points hide once the funnel confirms them. */
  renderedIds: string[];
  rows: TleRow[] | null;
  rowsFor: string | null;
  rowsLoading: boolean;
  rowsError: string | null;
  /** The point cloud's propagation worker failed (the cloud stops moving). */
  cloudError: string | null;
  perception: PerceptionResponse | null;
  /** Committed burns when the perception ran: a later approval makes it describe an old trajectory. */
  runCommitted: number;
  loading: boolean;
  error: string | null;
  step: number;
  playing: boolean;
  decision: Decision | null;
  drillLoading: boolean;
  drillError: string | null;
  run: () => Promise<void>;
  skip: () => void;
  decide: (kind: Decision['kind']) => Promise<void>;
  injectDrill: () => Promise<void>;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const reducedMotion = () => typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

let timer: ReturnType<typeof setTimeout> | null = null;
let runToken = 0;
/** The funnel hid the tracked-objects layer (it reveals the confirmed passes itself). */
let hidBackground = false;

function stopTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

function setBackground(on: boolean): void {
  const app = useAppStore.getState();
  if (app.layers.background !== on) useAppStore.setState({ layers: { ...app.layers, background: on } });
}

export const committedCount = () => useAppStore.getState().simulation?.committed_maneuvers?.length ?? 0;

const IDLE_STATE = { perception: null, runCommitted: 0, loading: false, error: null, step: IDLE, playing: false, decision: null, drillLoading: false, drillError: null };

export const usePerceptionStore = create<PerceptionState>()((set, get) => {
  const setStep = (step: number) => {
    set({ step });
    // the confirmed passes are globe entities: they appear with the confirmed step
    if (step >= STEP.confirmed && hidBackground) {
      setBackground(true);
      hidBackground = false;
    }
  };

  const advance = (token: number) => {
    if (token !== runToken) return;
    const next = get().step + 1;
    setStep(next);
    if (next >= LAST_STEP) {
      set({ playing: false });
      timer = null;
    } else {
      timer = setTimeout(() => advance(token), STEP_MS);
    }
  };

  return {
    active: false,
    scenarioId: null,
    resetCount: -1,
    renderedIds: [],
    rows: null,
    rowsFor: null,
    rowsLoading: false,
    rowsError: null,
    cloudError: null,
    ...IDLE_STATE,

    run: async () => {
      const { scenarioId, active } = get();
      if (!active || !scenarioId) return;
      stopTimer();
      const token = ++runToken;
      set({ loading: true, error: null, decision: null, playing: false });
      try {
        const runCommitted = committedCount();
        const perception = await perceptionApi.perceive(scenarioId);
        if (token !== runToken) return;
        set({ perception, runCommitted, loading: false });
        if (reducedMotion()) {
          setStep(LAST_STEP);
          return;
        }
        set({ playing: true });
        setStep(STEP.tracked);
        timer = setTimeout(() => advance(token), STEP_MS);
      } catch (e) {
        // a failed run leaves no stale funnel or verdict on screen
        if (token === runToken) set({ loading: false, error: errMsg(e), perception: null, step: IDLE, playing: false });
      }
    },

    skip: () => {
      stopTimer();
      runToken++;
      if (get().perception) setStep(LAST_STEP);
      set({ playing: false });
    },

    decide: async (kind) => {
      set({ decision: { kind, atUnix: controller.currentUnix } });
      const p = get().perception;
      if (kind !== 'maneuver' || !p) return;
      const v = verdictFor(p);
      if (v.kind !== 'alert') return;
      const threat = v.threats[0];
      const cid = threat.physics.linked_conjunction_id ?? threat.physics.conjunction_id;
      if (!cid) return;
      const app = useAppStore.getState();
      // planning needs the pass in the session's screening
      if (!app.screening?.conjunctions.some((c) => c.conjunction_id === cid)) await app.runScreening();
      useAppStore.getState().selectConjunction(cid);
      await useAppStore.getState().planManeuvers(cid);
    },

    injectDrill: async () => {
      const { scenarioId, resetCount, active } = get();
      if (!active || !scenarioId) return;
      // a switch or a reset while the requests are in flight makes their answers stale
      const stale = () => get().scenarioId !== scenarioId || get().resetCount !== resetCount;
      set({ drillLoading: true, drillError: null });
      try {
        const d = await perceptionApi.drill(scenarioId, isoOf(controller.currentUnix));
        if (stale()) return;
        const id = d.object.object_id;
        const app = useAppStore.getState();
        const span = app.dataWindow ?? { startUnix: app.scenario!.window.start_unix, endUnix: app.scenario!.window.end_unix };
        const step = Object.values(app.trajectories)[0]?.step_s ?? 120;
        const [detail, traj, simulation] = await Promise.all([
          api.scenario(scenarioId),
          api.trajectories(scenarioId, [id], step, isoOf(span.startUnix), isoOf(span.endUnix)),
          api.simulationState(scenarioId),
        ]);
        if (stale()) return;
        const drillPass = d.screening.conjunctions.find((c) => c.secondary_id === id);
        useAppStore.setState((s) => ({
          scenario: detail,
          objects: { ...s.objects, [id]: d.object },
          trajectories: { ...s.trajectories, ...Object.fromEntries((traj.trajectories ?? []).map((t) => [t.object_id, t])) },
          screening: d.screening,
          simulation,
          selectedConjunctionId: drillPass?.conjunction_id ?? s.selectedConjunctionId,
          plan: null,
          selectedManeuverId: null,
          candidateTrajectories: {},
        }));
        set({ drillLoading: false, renderedIds: detail.rendered_object_ids ?? [] });
        await get().run();
      } catch (e) {
        if (!stale()) set({ drillLoading: false, drillError: errMsg(e) });
      }
    },
  };
});

async function loadRows(scenarioId: string): Promise<void> {
  const st = usePerceptionStore.getState();
  if (st.rowsFor === scenarioId && (st.rows || st.rowsLoading)) return;
  usePerceptionStore.setState({ rowsFor: scenarioId, rowsLoading: true, rowsError: null, cloudError: null, rows: null });
  try {
    const res = await perceptionApi.catalogTles(scenarioId);
    if (usePerceptionStore.getState().rowsFor === scenarioId) usePerceptionStore.setState({ rows: res.rows ?? [], rowsLoading: false });
  } catch (e) {
    if (usePerceptionStore.getState().rowsFor === scenarioId) usePerceptionStore.setState({ rowsLoading: false, rowsError: errMsg(e) });
  }
}

function sync(scenario: ScenarioWithShortlist | null): void {
  const st = usePerceptionStore.getState();
  const id = scenario?.scenario_id ?? null;
  const resetCount = scenario?.simulation.reset_count ?? -1;
  if (id === st.scenarioId && resetCount === st.resetCount) return;
  stopTimer();
  runToken++;
  const active = !!scenario && scenario.kind === 'real' && !!scenario.screening_shortlist;
  usePerceptionStore.setState({ ...IDLE_STATE, active, scenarioId: id, resetCount, renderedIds: scenario?.rendered_object_ids ?? [] });
  if (active) {
    // before the funnel runs, the globe shows the station and the cloud of every tracked object
    if (useAppStore.getState().layers.background) {
      setBackground(false);
      hidBackground = true;
    }
    void loadRows(id!);
  } else if (hidBackground) {
    setBackground(true);
    hidBackground = false;
  }
}

/** Follow the app store's scenario. Returns the unsubscribe function. */
export function startPerceptionSync(): () => void {
  sync(useAppStore.getState().scenario as ScenarioWithShortlist | null);
  return useAppStore.subscribe((s, prev) => {
    if (s.scenario !== prev.scenario) sync(s.scenario as ScenarioWithShortlist | null);
  });
}
