import { create } from 'zustand';
import { ApiError, api } from '../api/client';
import type { LayerFlags } from '../globe/scene';
import { controller } from '../simulation/controller';
import type {
  AgentRun,
  Conjunction,
  HealthResponse,
  Maneuver,
  ObjectDetail,
  ObjectSummary,
  PlanResponse,
  ScenarioDetail,
  ScenarioSummary,
  ScreenResponse,
  SecondaryCheckResponse,
  SimulationState,
  Trajectory,
} from '../types/api';

export const DEFAULT_SCENARIO = 'synthetic-conjunction';

function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.status === 0 ? e.message : `${e.message} (HTTP ${e.status})`;
  return (e as Error)?.message ?? String(e);
}

function byId<T extends { object_id: string }>(items: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const it of items) out[it.object_id] = it;
  return out;
}

export interface AppState {
  backendStatus: 'checking' | 'online' | 'offline';
  health: HealthResponse | null;
  backendError: string | null;
  sceneReady: boolean;
  sceneError: string | null;
  scenarios: ScenarioSummary[];
  scenarioId: string;
  scenario: ScenarioDetail | null;
  scenarioLoading: boolean;
  scenarioError: string | null;
  objects: Record<string, ObjectSummary>;
  trajectories: Record<string, Trajectory>;
  selectedObjectId: string | null;
  objectDetail: ObjectDetail | null;
  objectDetailLoading: boolean;
  screening: ScreenResponse | null;
  screeningLoading: boolean;
  screeningError: string | null;
  selectedConjunctionId: string | null;
  plan: PlanResponse | null;
  planLoading: boolean;
  planError: string | null;
  selectedManeuverId: string | null;
  candidateTrajectories: Record<string, Trajectory>;
  secondaryChecks: Record<string, SecondaryCheckResponse>;
  secondaryLoading: string | null;
  agentRun: AgentRun | null;
  agentLoading: boolean;
  agentError: string | null;
  simulation: SimulationState | null;
  decisionLoading: boolean;
  decisionError: string | null;
  layers: LayerFlags;
  cameraResetNonce: number;
  notice: string | null;
  /** The right-hand mission panel is open (collapsed to a handle otherwise). */
  missionPanelOpen: boolean;

  selectedConjunction: () => Conjunction | null;
  selectedManeuver: () => Maneuver | null;

  init: () => Promise<void>;
  loadScenario: (id: string) => Promise<void>;
  resetScenario: () => Promise<void>;
  selectObject: (id: string | null) => void;
  refreshObjectDetail: () => Promise<void>;
  runScreening: (pcPolicy?: string) => Promise<void>;
  selectConjunction: (id: string | null) => void;
  planManeuvers: (conjunctionId?: string) => Promise<void>;
  selectManeuver: (id: string | null) => void;
  runSecondaryCheck: (maneuverId: string) => Promise<void>;
  runAgent: () => Promise<void>;
  approve: (maneuverId: string) => Promise<void>;
  reject: (maneuverId: string, reason?: string) => Promise<void>;
  toggleLayer: (key: keyof LayerFlags) => void;
  resetCamera: () => void;
  setSceneReady: (ok: boolean, error?: string) => void;
  dismissNotice: () => void;
  toggleMissionPanel: () => void;
}

const EMPTY_SESSION = {
  screening: null,
  screeningError: null,
  selectedConjunctionId: null,
  plan: null,
  planError: null,
  selectedManeuverId: null,
  candidateTrajectories: {},
  secondaryChecks: {},
  agentRun: null,
  agentError: null,
  decisionError: null,
  selectedObjectId: null,
  objectDetail: null,
} as const;

const MISSION_PANEL_KEY = 'aegis-orbit.missionPanelOpen';

function readMissionPanelOpen(): boolean {
  try {
    return localStorage.getItem(MISSION_PANEL_KEY) !== '0';
  } catch {
    return true;
  }
}

export const useAppStore = create<AppState>()((set, get) => ({
  backendStatus: 'checking',
  health: null,
  backendError: null,
  sceneReady: false,
  sceneError: null,
  scenarios: [],
  scenarioId: DEFAULT_SCENARIO,
  scenario: null,
  scenarioLoading: false,
  scenarioError: null,
  objects: {},
  trajectories: {},
  selectedObjectId: null,
  objectDetail: null,
  objectDetailLoading: false,
  screening: null,
  screeningLoading: false,
  screeningError: null,
  selectedConjunctionId: null,
  plan: null,
  planLoading: false,
  planError: null,
  selectedManeuverId: null,
  candidateTrajectories: {},
  secondaryChecks: {},
  secondaryLoading: null,
  agentRun: null,
  agentLoading: false,
  agentError: null,
  simulation: null,
  decisionLoading: false,
  decisionError: null,
  layers: { original: true, secondary: true, candidates: true, background: true, backgroundOrbits: false, markers: true, labels: true },
  cameraResetNonce: 0,
  notice: null,
  missionPanelOpen: readMissionPanelOpen(),

  selectedConjunction: () => {
    const { screening, selectedConjunctionId } = get();
    return screening?.conjunctions.find((c) => c.conjunction_id === selectedConjunctionId) ?? null;
  },
  selectedManeuver: () => {
    const { plan, selectedManeuverId } = get();
    return plan?.candidates.find((c) => c.maneuver_id === selectedManeuverId) ?? null;
  },

  init: async () => {
    set({ backendStatus: 'checking', backendError: null });
    try {
      const health = await api.health();
      const scenarios = await api.scenarios();
      set({ backendStatus: 'online', health, scenarios: scenarios ?? [] });
      await get().loadScenario(get().scenarioId);
    } catch (e) {
      set({ backendStatus: 'offline', backendError: errMsg(e), scenarios: [] });
    }
  },

  loadScenario: async (id) => {
    controller.pause();
    set({ scenarioId: id, scenarioLoading: true, scenarioError: null, scenario: null, objects: {}, trajectories: {}, simulation: null, ...EMPTY_SESSION });
    try {
      const detail = await api.scenario(id);
      const objs = await api.objects(id);
      const step = detail.kind === 'real' ? 120 : 60;
      const { trajectories } = await api.trajectories(id, detail.rendered_object_ids ?? [], step);
      controller.setWindow(detail.window.start_unix, detail.window.end_unix);
      set({
        scenario: detail,
        objects: byId(objs?.objects ?? []),
        trajectories: byId(trajectories ?? []),
        simulation: detail.simulation,
        scenarioLoading: false,
      });
      // Rehydrate session artefacts that already exist on the backend (e.g. after a page reload).
      if (detail.simulation.screening_performed) {
        try {
          const scr = await api.conjunctions(id);
          const first = scr.conjunctions[0]?.conjunction_id ?? null;
          set({ screening: scr, selectedConjunctionId: detail.simulation.active_conjunction_id ?? first });
          const approved = detail.simulation.approved_maneuver;
          const cid = approved?.conjunction_id ?? first;
          if (cid) {
            if (approved || detail.simulation.agent_run_count > 0) {
              try {
                const plan = await api.existingPlan(id, cid);
                await hydratePlan(set, get, plan, approved?.maneuver_id ?? null);
              } catch {
                /* no plan yet */
              }
            }
          }
        } catch {
          /* screening results unavailable */
        }
      }
    } catch (e) {
      set({ scenarioLoading: false, scenarioError: errMsg(e), objects: {}, trajectories: {} });
    }
  },

  resetScenario: async () => {
    const id = get().scenarioId;
    controller.pause();
    set({ scenarioLoading: true, scenarioError: null, ...EMPTY_SESSION });
    try {
      const detail = await api.resetScenario(id);
      controller.setWindow(detail.window.start_unix, detail.window.end_unix);
      controller.reset();
      set({ scenario: detail, simulation: detail.simulation, scenarioLoading: false, notice: 'Scenario reset to its initial state.' });
    } catch (e) {
      set({ scenarioLoading: false, scenarioError: errMsg(e) });
    }
  },

  selectObject: (id) => {
    set({ selectedObjectId: id, objectDetail: null });
    if (id) void get().refreshObjectDetail();
  },

  refreshObjectDetail: async () => {
    const { scenarioId, selectedObjectId } = get();
    if (!selectedObjectId) return;
    set({ objectDetailLoading: true });
    try {
      const at = new Date(controller.currentUnix * 1000).toISOString();
      const detail = await api.objectDetail(scenarioId, selectedObjectId, at);
      if (get().selectedObjectId === selectedObjectId) set({ objectDetail: detail, objectDetailLoading: false });
    } catch (e) {
      set({ objectDetailLoading: false, notice: `Object details unavailable: ${errMsg(e)}` });
    }
  },

  runScreening: async (pcPolicy) => {
    const { scenarioId } = get();
    set({ screeningLoading: true, screeningError: null });
    try {
      const scr = await api.screen(scenarioId, pcPolicy ? { pc_policy: pcPolicy } : {});
      const sim = await api.simulationState(scenarioId);
      const first = scr.conjunctions[0]?.conjunction_id ?? null;
      const keepPlan = get().plan && scr.conjunctions.some((c) => c.conjunction_id === get().plan?.conjunction_id);
      set({
        screening: scr,
        simulation: sim,
        screeningLoading: false,
        selectedConjunctionId: first,
        plan: keepPlan ? get().plan : null,
        selectedManeuverId: keepPlan ? get().selectedManeuverId : null,
        candidateTrajectories: keepPlan ? get().candidateTrajectories : {},
      });
    } catch (e) {
      set({ screeningLoading: false, screeningError: errMsg(e), screening: null, selectedConjunctionId: null });
    }
  },

  selectConjunction: (id) => set({ selectedConjunctionId: id }),

  planManeuvers: async (conjunctionId) => {
    const { scenarioId } = get();
    const cid = conjunctionId ?? get().selectedConjunctionId;
    if (!cid) return;
    set({ planLoading: true, planError: null });
    try {
      const plan = await api.planManeuvers(scenarioId, cid, 3);
      await hydratePlan(set, get, plan, null);
      set({ planLoading: false });
      // Secondary screening for the recommended candidates so the comparison is complete.
      for (const mid of plan.recommended_ids) await get().runSecondaryCheck(mid);
    } catch (e) {
      set({ planLoading: false, planError: errMsg(e) });
    }
  },

  selectManeuver: (id) => set({ selectedManeuverId: id }),

  runSecondaryCheck: async (maneuverId) => {
    const { scenarioId } = get();
    set({ secondaryLoading: maneuverId });
    try {
      const res = await api.secondaryCheck(scenarioId, maneuverId);
      const plan = get().plan;
      const updated = plan
        ? {
            ...plan,
            candidates: plan.candidates.map((c) =>
              c.maneuver_id === maneuverId
                ? {
                    ...c,
                    secondary_check: {
                      validation_status: res.validation_status,
                      complete: res.complete,
                      new_conjunctions: res.new_conjunctions.length,
                      worst_new_state: res.worst_new_state,
                      original_encounter: res.original_encounter,
                      limitations: res.limitations,
                    },
                  }
                : c,
            ),
          }
        : plan;
      set({ secondaryChecks: { ...get().secondaryChecks, [maneuverId]: res }, plan: updated, secondaryLoading: null });
    } catch (e) {
      set({ secondaryLoading: null, notice: `Secondary check failed: ${errMsg(e)}` });
    }
  },

  runAgent: async () => {
    const { scenarioId, selectedConjunctionId } = get();
    set({ agentLoading: true, agentError: null });
    try {
      const run = await api.analyze(scenarioId, selectedConjunctionId ?? undefined);
      set({ agentRun: run, simulation: run.simulation });
      // The agent may have screened and planned; pull those artefacts into the UI.
      try {
        const scr = await api.conjunctions(scenarioId);
        const cid = run.report?.threat.conjunction_id ?? scr.conjunctions[0]?.conjunction_id ?? null;
        set({ screening: scr, selectedConjunctionId: cid });
        if (cid) {
          try {
            const plan = await api.existingPlan(scenarioId, cid);
            await hydratePlan(set, get, plan, run.report?.recommended_maneuver_id ?? null);
          } catch {
            /* the agent may not have planned */
          }
        }
      } catch {
        /* nothing screened */
      }
      set({ agentLoading: false });
    } catch (e) {
      set({ agentLoading: false, agentError: errMsg(e) });
    }
  },

  approve: async (maneuverId) => {
    const { scenarioId } = get();
    set({ decisionLoading: true, decisionError: null });
    try {
      const res = await api.approve(scenarioId, maneuverId);
      const checks = res.secondary_check ? { ...get().secondaryChecks, [maneuverId]: res.secondary_check } : get().secondaryChecks;
      let candidateTrajectories = get().candidateTrajectories;
      if (!candidateTrajectories[maneuverId]) {
        const t = await api.trajectory(scenarioId, get().scenario!.primary_id, { maneuver_id: maneuverId, step_s: 60 });
        candidateTrajectories = { ...candidateTrajectories, [maneuverId]: t };
      }
      set({ simulation: res.simulation, secondaryChecks: checks, candidateTrajectories, selectedManeuverId: maneuverId, decisionLoading: false });
    } catch (e) {
      set({ decisionLoading: false, decisionError: errMsg(e) });
    }
  },

  reject: async (maneuverId, reason) => {
    const { scenarioId } = get();
    set({ decisionLoading: true, decisionError: null });
    try {
      const res = await api.reject(scenarioId, maneuverId, reason);
      set({ simulation: res.simulation, decisionLoading: false });
    } catch (e) {
      set({ decisionLoading: false, decisionError: errMsg(e) });
    }
  },

  toggleLayer: (key) => set({ layers: { ...get().layers, [key]: !get().layers[key] } }),
  resetCamera: () => set({ cameraResetNonce: get().cameraResetNonce + 1 }),
  setSceneReady: (ok, error) => set({ sceneReady: ok, sceneError: error ?? null }),
  dismissNotice: () => set({ notice: null }),
  toggleMissionPanel: () => {
    const open = !get().missionPanelOpen;
    try {
      localStorage.setItem(MISSION_PANEL_KEY, open ? '1' : '0');
    } catch {
      // storage unavailable (private window, blocked site data): the choice lasts for this session only
    }
    set({ missionPanelOpen: open });
  },
}));

async function hydratePlan(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  plan: PlanResponse,
  preferredManeuverId: string | null,
): Promise<void> {
  const { scenarioId, scenario } = get();
  const ids = [...plan.recommended_ids];
  if (preferredManeuverId && !ids.includes(preferredManeuverId)) ids.push(preferredManeuverId);
  const existing = get().candidateTrajectories;
  const fetched = await Promise.all(
    ids.map(async (mid) => {
      if (existing[mid]) return [mid, existing[mid]] as const;
      try {
        return [mid, await api.trajectory(scenarioId, scenario!.primary_id, { maneuver_id: mid, step_s: 60 })] as const;
      } catch {
        return [mid, null] as const;
      }
    }),
  );
  const candidateTrajectories: Record<string, Trajectory> = { ...existing };
  for (const [mid, t] of fetched) if (t) candidateTrajectories[mid] = t;
  set({
    plan,
    candidateTrajectories,
    selectedManeuverId: preferredManeuverId ?? plan.recommended_ids[0] ?? null,
    selectedConjunctionId: plan.conjunction_id,
  });
}
