import { create } from 'zustand';
import { ApiError, api } from '../api/client';
import { detectionRadii } from '../globe/detectionRadius';
import type { CameraMode, CameraRange, LayerFlags } from '../globe/scene';
import { nextThreat } from '../lib/nextThreat';
import { SPEED_OPTIONS, controller, type ControllerState } from '../simulation/controller';
import { eventWithin } from '../simulation/events';
import {
  GHOST_MAX_ATTEMPTS,
  aliveGhosts,
  crashPointOf,
  expiredGhostIds,
  ghostCrashEvents,
  ghostFetchRange,
  ghostPhase,
  ghostsFromCommitted,
  type Ghost,
} from '../simulation/ghosts';
import { KEEP_BEHIND_ORBITS, extensionNeeded, mergeTrajectory, nextChunk, stalled, trimTrajectory } from '../simulation/rolling';
import { SLOW_FAR_S, SLOW_MAX_MISS_KM, earliestBurnAfterS, shouldEvaluate, slowSpeedFor } from '../sandbox/schedule';
import { junkKindInfo } from '../sandbox/junkKinds';
import type {
  AgentRun,
  CommittedManeuver,
  Conjunction,
  EvaluateAction,
  HealthResponse,
  JunkKind,
  JunkTypesResponse,
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
/** Trajectory sample spacing per scenario kind (seconds). */
const STEP_REAL_S = 120;
const STEP_SYNTHETIC_S = 60;
/** Orbit data kept behind a resumed sandbox clock (fraction of an orbit): the past trail and a little more. */
const TRAIL_FRACTION = 0.25;
/** A pass is over this long after its closest approach: the selection moves on to the next threat. */
const PASS_DONE_S = 90;
/** One shared empty list, so an untouched ghost slice keeps its identity across renders. */
const NO_GHOSTS: Ghost[] = [];

function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.status === 0 ? e.message : `${e.message} (HTTP ${e.status})`;
  return (e as Error)?.message ?? String(e);
}

function byId<T extends { object_id: string }>(items: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const it of items) out[it.object_id] = it;
  return out;
}

export function isoOf(unix: number): string {
  return new Date(unix * 1000).toISOString();
}

export interface SandboxState {
  /** The loaded scenario is the sandbox (kind 'sandbox'). */
  enabled: boolean;
  autopilot: boolean;
  spawnedIds: string[];
  randomCount: number;
  evaluateInFlight: boolean;
  /** A forced evaluation asked for while one was running. */
  pendingEvaluate: boolean;
  spawnInFlight: boolean;
  lastEvaluatedUnix: number | null;
  lastEvaluateRealMs: number;
  /** End of the horizon the last evaluation screened. */
  screeningEndUnix: number | null;
  lastActions: EvaluateAction[];
  /** Unavoidable passes already announced (conjunction ids). */
  announced: string[];
  junkTypes: JunkTypesResponse | null;
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
  /** The span of orbit data loaded for the rendered objects (the scenario window, or the rolling window in the sandbox). */
  dataWindow: { startUnix: number; endUnix: number } | null;
  rollingLoading: boolean;
  rollingRetryAtMs: number;
  /** The clock caught up with the loaded data and waits for the next chunk. */
  dataStall: boolean;
  pausedForData: boolean;
  /** Ghosts of the spacecraft: one per committed burn, flying the course it did not take (simulation/ghosts.ts). */
  ghosts: Ghost[];
  /** What the corner close-up follows: the real spacecraft, or a ghost by its burn id. */
  insetTarget: 'primary' | string;
  /** The ghost the close-up last switched to by itself when it was born (once per ghost). */
  ghostAutoSwitched: string | null;
  /** A committed burn is firing on the main globe right now. */
  burnFiring: { maneuverId: string } | null;
  /** Slow motion around a pass or a burn is holding the speed down; the user's speed is restored afterwards. */
  autoSlow: { restoreSpeed: number; eventId: string; kind: 'burn' | 'tca' | 'ghost' } | null;
  /** An event (pass or burn) the user overrode the slow motion for. */
  autoSlowSkip: string | null;
  /** The corner close-up's zoom requests (factor > 1 zooms in); the nonce makes each press count. */
  insetZoom: { factor: number; nonce: number };
  /** Bumped to put the close-up back on its default view of the spacecraft. */
  insetResetNonce: number;
  /** The close-up fills the stage (a focus view) instead of sitting in the corner. */
  insetExpanded: boolean;
  /** The close-up camera's distance to what it follows and its zoom range, as the scene reports them. */
  insetCamera: CameraRange | null;
  /** A distance asked for from the UI (the zoom slider); the nonce makes each request an event. */
  insetRangeRequest: { rangeM: number; nonce: number };
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
  /** Which model the agent runs with (Settings); the backend falls back to deterministic when Gemini has no key. */
  agentMode: AgentMode;
  simulation: SimulationState | null;
  decisionLoading: boolean;
  decisionError: string | null;
  layers: LayerFlags;
  cameraResetNonce: number;
  /** Globe camera: 'world' looks around the turning Earth, 'follow' rides with the spacecraft. */
  cameraMode: CameraMode;
  notice: string | null;
  /** The right-hand mission panel is open (collapsed to a handle otherwise). */
  missionPanelOpen: boolean;
  /** Sandbox: hold the clock down around each closest approach so the pass is watchable. */
  slowForPasses: boolean;
  sandbox: SandboxState;

  selectedConjunction: () => Conjunction | null;
  selectedManeuver: () => Maneuver | null;
  /** Burns that are part of the primary's trajectory (approved by a human or committed by the autopilot). */
  committedManeuvers: () => CommittedManeuver[];

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
  setCameraMode: (mode: CameraMode) => void;
  setSceneReady: (ok: boolean, error?: string) => void;
  setNotice: (text: string | null) => void;
  dismissNotice: () => void;
  toggleMissionPanel: () => void;
  setSpeed: (speed: number) => void;
  setSlowForPasses: (on: boolean) => void;
  setAgentMode: (mode: AgentMode) => void;
  setBurnFiring: (info: { maneuverId: string } | null) => void;
  zoomInset: (factor: number) => void;
  resetInset: () => void;
  setInsetExpanded: (expanded: boolean) => void;
  setInsetCamera: (range: CameraRange) => void;
  requestInsetRange: (rangeM: number) => void;
  /** Every clock notification: rolling data, sandbox evaluation, slow motion around passes. */
  onClockTick: (state: ControllerState) => void;
  /** The work of onClockTick (separate so a tick caused by a tick is ignored). */
  liveTick: (state: ControllerState) => void;
  extendTrajectories: () => Promise<void>;
  /** Re-read the primary's path (its committed burns included). */
  refreshPrimaryTrajectory: () => Promise<void>;
  /** Derive the ghosts from the committed burns and fetch the courses that are still missing. */
  syncGhosts: () => void;
  fetchGhostTrajectory: (id: string) => Promise<void>;
  /** Point the corner close-up at the real spacecraft ('primary') or at a ghost. */
  setInsetTarget: (target: 'primary' | string) => void;
  evaluateSandbox: (trigger: 'load' | 'tick' | 'spawn' | 'autopilot' | 'manual') => Promise<void>;
  spawnJunk: (kind: JunkKind, opts?: { timeToTcaS?: number }) => Promise<void>;
  spawnRandom: (count: number) => Promise<void>;
  /** Take the `count` most recently spawned pieces out of the sandbox. */
  removeJunk: (count: number) => Promise<void>;
  setAutopilot: (on: boolean) => Promise<void>;
  setRandomCount: (n: number) => void;
}

const EMPTY_SANDBOX: SandboxState = {
  enabled: false, autopilot: false, spawnedIds: [], randomCount: 5, evaluateInFlight: false, pendingEvaluate: false,
  spawnInFlight: false, lastEvaluatedUnix: null, lastEvaluateRealMs: 0, screeningEndUnix: null, lastActions: [], announced: [], junkTypes: null,
};

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
  ghosts: NO_GHOSTS,
  insetTarget: 'primary' as const,
  ghostAutoSwitched: null,
  burnFiring: null,
  autoSlow: null,
  autoSlowSkip: null,
} as const;

const MISSION_PANEL_KEY = 'aegis-orbit.missionPanelOpen';
const SPEED_KEY = 'aegis-orbit.simSpeed';
const SLOW_FOR_PASSES_KEY = 'aegis-orbit.slowForPasses';
const AGENT_MODE_KEY = 'aegis-orbit.agentMode';

export type AgentMode = 'gemini' | 'deterministic';

// Per-viewer conveniences only: storage can be empty or throw (private windows, blocked site data).
function readMissionPanelOpen(): boolean {
  try {
    return localStorage.getItem(MISSION_PANEL_KEY) !== '0';
  } catch {
    return true;
  }
}

function readSpeed(): number {
  try {
    const v = Number(localStorage.getItem(SPEED_KEY));
    return SPEED_OPTIONS.includes(v) ? v : 60;
  } catch {
    return 60;
  }
}

function readSlowForPasses(): boolean {
  try {
    return localStorage.getItem(SLOW_FOR_PASSES_KEY) !== '0';
  } catch {
    return true;
  }
}

function readAgentMode(): AgentMode {
  try {
    return localStorage.getItem(AGENT_MODE_KEY) === 'deterministic' ? 'deterministic' : 'gemini';
  } catch {
    return 'gemini';
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the choice lasts for this session only
  }
}

/** `?scenario=` on /mission opens that scenario (the home page links to each). */
function initialScenarioId(): string {
  try {
    return new URLSearchParams(window.location.search).get('scenario') || DEFAULT_SCENARIO;
  } catch {
    return DEFAULT_SCENARIO;
  }
}

function rememberScenarioInUrl(id: string): void {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('scenario') === id) return;
    url.searchParams.set('scenario', id);
    window.history.replaceState(null, '', url);
  } catch {
    // not in a browser, or history unavailable
  }
}

// onClockTick changes the clock speed, which notifies the clock's subscribers, which includes onClockTick:
// the store is updated before the speed changes and nested ticks are ignored.
let ticking = false;

function stepFor(kind: ScenarioDetail['kind']): number {
  return kind === 'real' ? STEP_REAL_S : STEP_SYNTHETIC_S;
}

function primaryPeriod(state: Pick<AppState, 'scenario' | 'objects'>): number {
  return (state.scenario && state.objects[state.scenario.primary_id]?.period_s) || 5600;
}

/** The screening a sandbox evaluation returns, in the shape the panels read. */
function screeningFromEvaluate(scenario: ScenarioDetail, conjunctions: Conjunction[], stats: Record<string, unknown>, simulation: SimulationState): ScreenResponse {
  return {
    scenario_id: scenario.scenario_id,
    primary_id: scenario.primary_id,
    conjunctions,
    stats,
    co_orbital: [],
    propagation_failures: [],
    overall_threat_state: simulation.overall_threat_state,
    pc_policy: scenario.pc_policy,
    thresholds: scenario.thresholds,
  };
}

export const useAppStore = create<AppState>()((set, get) => ({
  backendStatus: 'checking',
  health: null,
  backendError: null,
  sceneReady: false,
  sceneError: null,
  scenarios: [],
  scenarioId: initialScenarioId(),
  scenario: null,
  scenarioLoading: false,
  scenarioError: null,
  objects: {},
  trajectories: {},
  dataWindow: null,
  rollingLoading: false,
  rollingRetryAtMs: 0,
  dataStall: false,
  pausedForData: false,
  ghosts: NO_GHOSTS,
  insetTarget: 'primary',
  ghostAutoSwitched: null,
  burnFiring: null,
  autoSlow: null,
  autoSlowSkip: null,
  insetZoom: { factor: 1, nonce: 0 },
  insetResetNonce: 0,
  insetExpanded: false,
  insetCamera: null,
  insetRangeRequest: { rangeM: 0, nonce: 0 },
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
  agentMode: readAgentMode(),
  simulation: null,
  decisionLoading: false,
  decisionError: null,
  layers: { original: true, secondary: true, candidates: true, background: true, backgroundOrbits: false, markers: true, detection: true, labels: true },
  cameraResetNonce: 0,
  cameraMode: 'world',
  notice: null,
  missionPanelOpen: readMissionPanelOpen(),
  slowForPasses: readSlowForPasses(),
  sandbox: EMPTY_SANDBOX,

  selectedConjunction: () => {
    const { screening, selectedConjunctionId } = get();
    return screening?.conjunctions.find((c) => c.conjunction_id === selectedConjunctionId) ?? null;
  },
  committedManeuvers: () => get().simulation?.committed_maneuvers ?? [],
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
      const wanted = get().scenarioId;
      const known = (scenarios ?? []).some((s) => s.scenario_id === wanted);
      await get().loadScenario(known || !(scenarios ?? []).length ? wanted : DEFAULT_SCENARIO);
    } catch (e) {
      set({ backendStatus: 'offline', backendError: errMsg(e), scenarios: [] });
    }
  },

  loadScenario: async (id) => {
    controller.pause();
    set({
      scenarioId: id, scenarioLoading: true, scenarioError: null, scenario: null, objects: {}, trajectories: {}, simulation: null,
      dataWindow: null, dataStall: false, pausedForData: false, rollingLoading: false, sandbox: EMPTY_SANDBOX, ...EMPTY_SESSION,
    });
    try {
      const detail = await api.scenario(id);
      const objs = await api.objects(id);
      const step = stepFor(detail.kind);
      const sandbox = detail.kind === 'sandbox';
      const period = objs?.objects?.find((o) => o.object_id === detail.primary_id)?.period_s ?? 5600;
      const windowStart = detail.window.start_unix;
      // A sandbox session outlives the page: after a reload the clock resumes where the backend last saw
      // it (spawned junk and committed burns are dated there), with a short tail of data behind it.
      const resumeAt = sandbox && detail.simulation.clock_unix ? Math.max(windowStart, detail.simulation.clock_unix) : windowStart;
      const start = sandbox ? Math.max(windowStart, resumeAt - period * TRAIL_FRACTION) : windowStart;
      // The realistic and scripted scenarios load their whole window; the sandbox loads a first chunk and
      // keeps fetching ahead of the clock (see extendTrajectories).
      const end = sandbox ? nextChunk(resumeAt, period, readSpeed(), step).end : detail.window.end_unix;
      const { trajectories } = await api.trajectories(id, detail.rendered_object_ids ?? [], step, isoOf(start), isoOf(end));
      if (get().scenarioId !== id) return;
      // Their fixed window keeps Play and the scrubber; the sandbox clock is open-ended.
      controller.setWindow(windowStart, sandbox ? null : detail.window.end_unix, resumeAt);
      set({
        scenario: detail,
        objects: byId(objs?.objects ?? []),
        trajectories: byId(trajectories ?? []),
        simulation: detail.simulation,
        scenarioLoading: false,
        dataWindow: { startUnix: start, endUnix: end },
        sandbox: sandbox
          ? { ...EMPTY_SANDBOX, enabled: true, autopilot: detail.simulation.autopilot, spawnedIds: detail.simulation.spawned_object_ids ?? [] }
          : EMPTY_SANDBOX,
      });
      rememberScenarioInUrl(id);
      get().syncGhosts();
      if (sandbox) {
        // live from the first frame: the spacecraft is already orbiting when the page opens
        controller.setSpeed(readSpeed());
        controller.play();
        void api.junkTypes().then((junkTypes) => {
          if (get().scenarioId === id) set({ sandbox: { ...get().sandbox, junkTypes } });
        }).catch(() => undefined);
        void get().evaluateSandbox('load');
      }
      // Rehydrate session artefacts that already exist on the backend (e.g. after a page reload).
      if (detail.simulation.screening_performed && !sandbox) {
        try {
          const scr = await api.conjunctions(id);
          const committedTimes = detail.simulation.burn_times_unix ?? [];
          set({ screening: scr, selectedConjunctionId: detail.simulation.active_conjunction_id ?? nextThreat(scr.conjunctions, committedTimes, controller.currentUnix) });
          const approved = detail.simulation.approved_maneuver;
          const cid = approved?.conjunction_id ?? scr.conjunctions[0]?.conjunction_id ?? null;
          if (cid && (approved || detail.simulation.agent_run_count > 0)) {
            try {
              const plan = await api.existingPlan(id, cid);
              await hydratePlan(set, get, plan, approved?.maneuver_id ?? null);
            } catch {
              /* no plan yet */
            }
          }
        } catch {
          /* screening results unavailable */
        }
      }
    } catch (e) {
      if (get().scenarioId === id) set({ scenarioLoading: false, scenarioError: errMsg(e), objects: {}, trajectories: {} });
    }
  },

  resetScenario: async () => {
    const id = get().scenarioId;
    controller.pause();
    set({ scenarioLoading: true, scenarioError: null, ...EMPTY_SESSION });
    try {
      await api.resetScenario(id);
      // A reset rebuilds the backend session: committed burns and spawned junk are gone, so reload everything.
      await get().loadScenario(id);
      set({ notice: 'Scenario reset to its initial state.' });
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
      const detail = await api.objectDetail(scenarioId, selectedObjectId, isoOf(controller.currentUnix));
      if (get().selectedObjectId === selectedObjectId) set({ objectDetail: detail, objectDetailLoading: false });
    } catch (e) {
      set({ objectDetailLoading: false, notice: `Object details unavailable: ${errMsg(e)}` });
    }
  },

  runScreening: async (pcPolicy) => {
    const { scenarioId, sandbox } = get();
    set({ screeningLoading: true, screeningError: null });
    try {
      const scr = await api.screen(scenarioId, {
        ...(pcPolicy ? { pc_policy: pcPolicy } : {}),
        ...(sandbox.enabled ? { start: isoOf(controller.currentUnix) } : {}),
      });
      const sim = await api.simulationState(scenarioId);
      const keepPlan = get().plan && scr.conjunctions.some((c) => c.conjunction_id === get().plan?.conjunction_id);
      set({
        screening: scr,
        simulation: sim,
        screeningLoading: false,
        selectedConjunctionId: nextThreat(scr.conjunctions, sim.burn_times_unix ?? [], controller.currentUnix),
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
    const { scenarioId, sandbox } = get();
    const cid = conjunctionId ?? get().selectedConjunctionId;
    if (!cid) return;
    set({ planLoading: true, planError: null });
    try {
      const plan = await api.planManeuvers(scenarioId, cid, 3, sandbox.enabled ? isoOf(controller.currentUnix + 120) : undefined);
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
    const { scenarioId, selectedConjunctionId, agentMode } = get();
    set({ agentLoading: true, agentError: null });
    try {
      // "Gemini" in Settings is a preference: the backend's auto mode tries the Gemini models, then falls
      // back to the deterministic agent (an explicit "gemini" would turn a quota or outage into an error)
      const run = await api.analyze(scenarioId, selectedConjunctionId ?? undefined, agentMode === 'gemini' ? 'auto' : agentMode);
      set({ agentRun: run, simulation: run.simulation });
      // The agent may have screened and planned; pull those artefacts into the UI.
      try {
        const scr = await api.conjunctions(scenarioId);
        const cid = run.report?.threat.conjunction_id ?? nextThreat(scr.conjunctions, run.simulation.burn_times_unix ?? [], controller.currentUnix);
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
      set({ simulation: res.simulation, secondaryChecks: checks, decisionLoading: false });
      get().syncGhosts();
      // The burn is now part of the trajectory: the globe draws the committed path, a ghost keeps the old one.
      await get().refreshPrimaryTrajectory();
      // Commit re-screens against the new path (ids can change) and candidates planned before it are stale.
      try {
        const scr = await api.conjunctions(scenarioId);
        const committedIds = new Set((res.simulation.committed_maneuvers ?? []).map((m) => m.maneuver_id));
        const kept: Record<string, Trajectory> = {};
        for (const [mid, t] of Object.entries(get().candidateTrajectories)) if (committedIds.has(mid)) kept[mid] = t;
        set({
          screening: scr,
          plan: null,
          selectedManeuverId: null,
          candidateTrajectories: kept,
          selectedConjunctionId: nextThreat(scr.conjunctions, res.simulation.burn_times_unix ?? [], controller.currentUnix),
        });
      } catch {
        /* the previous screening stays on screen */
      }
    } catch (e) {
      set({ decisionLoading: false, decisionError: errMsg(e) });
    }
  },

  reject: async (maneuverId, reason) => {
    const { scenarioId } = get();
    const wasCommitted = get().committedManeuvers().some((m) => m.maneuver_id === maneuverId);
    set({ decisionLoading: true, decisionError: null });
    try {
      const res = await api.reject(scenarioId, maneuverId, reason);
      set({ simulation: res.simulation, decisionLoading: false });
      get().syncGhosts();
      if (wasCommitted) {
        await get().refreshPrimaryTrajectory();
        try {
          const scr = await api.conjunctions(scenarioId);
          set({ screening: scr, selectedConjunctionId: nextThreat(scr.conjunctions, res.simulation.burn_times_unix ?? [], controller.currentUnix) });
        } catch {
          /* keep the previous screening */
        }
      }
    } catch (e) {
      set({ decisionLoading: false, decisionError: errMsg(e) });
    }
  },

  toggleLayer: (key) => set({ layers: { ...get().layers, [key]: !get().layers[key] } }),
  resetCamera: () => set({ cameraResetNonce: get().cameraResetNonce + 1 }),
  setCameraMode: (mode) => set({ cameraMode: mode }),
  setSceneReady: (ok, error) => set({ sceneReady: ok, sceneError: error ?? null }),
  setNotice: (text) => set({ notice: text }),
  dismissNotice: () => set({ notice: null }),
  toggleMissionPanel: () => {
    const open = !get().missionPanelOpen;
    persist(MISSION_PANEL_KEY, open ? '1' : '0');
    set({ missionPanelOpen: open });
  },
  setSpeed: (speed) => {
    // a speed the user picks during slow motion stands for the rest of that pass or burn
    const slow = get().autoSlow;
    set({ autoSlow: null, autoSlowSkip: slow?.eventId ?? get().autoSlowSkip });
    persist(SPEED_KEY, String(speed));
    controller.setSpeed(speed);
  },
  setSlowForPasses: (on) => {
    persist(SLOW_FOR_PASSES_KEY, on ? '1' : '0');
    const { autoSlow } = get();
    set({ slowForPasses: on, autoSlow: on ? autoSlow : null });
    if (!on && autoSlow) controller.setSpeed(autoSlow.restoreSpeed);
  },
  setAgentMode: (mode) => {
    persist(AGENT_MODE_KEY, mode);
    set({ agentMode: mode });
  },
  setBurnFiring: (info) => {
    if ((get().burnFiring?.maneuverId ?? null) !== (info?.maneuverId ?? null)) set({ burnFiring: info });
  },
  zoomInset: (factor) => set({ insetZoom: { factor, nonce: get().insetZoom.nonce + 1 } }),
  resetInset: () => set({ insetResetNonce: get().insetResetNonce + 1 }),
  setInsetExpanded: (expanded) => set({ insetExpanded: expanded }),
  setInsetCamera: (range) => set({ insetCamera: range }),
  requestInsetRange: (rangeM) => set({ insetRangeRequest: { rangeM, nonce: get().insetRangeRequest.nonce + 1 } }),

  // ---------------------------------------------------------------- the live loop (sandbox)
  onClockTick: (st) => {
    if (ticking) return;
    ticking = true;
    try {
      get().liveTick(st);
    } finally {
      ticking = false;
    }
  },

  liveTick: (st) => {
    const s = get();
    if (!s.scenario) return;
    const now = st.currentUnix;
    if (s.sandbox.enabled) {
      const period = primaryPeriod(s);
      if (s.dataWindow) {
        if (st.playing && stalled(now, s.dataWindow.endUnix)) {
          controller.pause();
          set({ dataStall: true, pausedForData: true });
        }
        if (extensionNeeded(now, st.speed, s.dataWindow.endUnix, period)) void s.extendTrajectories();
      }
      const sb = s.sandbox;
      if (shouldEvaluate({ enabled: sb.enabled, inFlight: sb.evaluateInFlight, nowUnix: now, lastEvaluatedUnix: sb.lastEvaluatedUnix, screeningEndUnix: sb.screeningEndUnix, periodS: period, lastEvaluateRealMs: sb.lastEvaluateRealMs, realNowMs: performance.now() })) {
        void s.evaluateSandbox('tick');
      }
      // a pass that is over no longer deserves the spotlight: move the selection on
      const selected = s.selectedConjunction();
      if (selected && selected.tca_unix < now - PASS_DONE_S && s.screening) {
        const upcoming = s.screening.conjunctions.filter((c) => c.tca_unix > now);
        const next = nextThreat(upcoming, s.simulation?.burn_times_unix ?? [], now);
        set({ selectedConjunctionId: next !== selected.conjunction_id ? next : null });
      }
    }
    // Ghosts: an open-ended clock forgets a ghost once its collision is over (a bounded one can scrub
    // back to it); the close-up switches to a ghost when it is born (once per ghost, at the burn, not
    // as its collision nears) and comes back to the spacecraft whenever the ghost it follows is not
    // flying at this time.
    const expired = expiredGhostIds(s.ghosts, now, st.openEnded);
    if (expired.length) {
      const gone = new Set(expired);
      set({ ghosts: s.ghosts.filter((g) => !gone.has(g.id)), insetTarget: gone.has(s.insetTarget) ? 'primary' : s.insetTarget });
    }
    let cur = get();
    const newborn = cur.ghosts
      .filter((g) => ghostPhase(g, now) === 'alive')
      .reduce<Ghost | null>((best, g) => (!best || g.bornUnix > best.bornUnix ? g : best), null);
    if (newborn && newborn.id !== cur.ghostAutoSwitched) {
      set({ insetTarget: newborn.id, ghostAutoSwitched: newborn.id });
    } else if (cur.insetTarget !== 'primary' && !aliveGhosts(cur.ghosts, now).some((g) => g.id === cur.insetTarget)) {
      set({ insetTarget: 'primary' });
    }
    cur = get();
    // slow motion around a dodge burn, a close pass or a ghost's collision (outside the sandbox: ghosts only)
    const crashes = ghostCrashEvents(cur.ghosts, now);
    const inSandbox = cur.sandbox.enabled;
    const ev = cur.slowForPasses
      ? eventWithin(inSandbox ? cur.screening : null, inSandbox ? cur.simulation?.committed_maneuvers : null, now, SLOW_FAR_S, SLOW_MAX_MISS_KM, crashes)
      : null;
    const eligible = ev && ev.id !== cur.autoSlowSkip ? ev : null;
    if (eligible) {
      const base = cur.autoSlow?.restoreSpeed ?? st.speed;
      const target = slowSpeedFor(eligible.atUnix - now, base);
      if (target !== null) {
        if (!cur.autoSlow || cur.autoSlow.eventId !== eligible.id) set({ autoSlow: { restoreSpeed: cur.autoSlow?.restoreSpeed ?? st.speed, eventId: eligible.id, kind: eligible.kind } });
        if (st.speed !== target) controller.setSpeed(target);
        return;
      }
    }
    if (cur.autoSlow) {
      set({ autoSlow: null });
      controller.setSpeed(cur.autoSlow.restoreSpeed);
    }
  },

  extendTrajectories: async () => {
    const s = get();
    if (!s.scenario || !s.dataWindow || s.rollingLoading || performance.now() < s.rollingRetryAtMs) return;
    const scenarioId = s.scenario.scenario_id;
    const resetCount = s.scenario.simulation.reset_count;
    const period = primaryPeriod(s);
    const step = stepFor(s.scenario.kind);
    const ids = Array.from(new Set([...(s.scenario.rendered_object_ids ?? []), ...s.sandbox.spawnedIds]));
    const { start, end } = nextChunk(s.dataWindow.endUnix, period, controller.speed, step);
    set({ rollingLoading: true });
    try {
      const { trajectories: chunks } = await api.trajectories(scenarioId, ids, step, isoOf(start), isoOf(end));
      const cur = get();
      if (cur.scenario?.scenario_id !== scenarioId || cur.scenario.simulation.reset_count !== resetCount || !cur.dataWindow) return;
      const keepFrom = controller.currentUnix - KEEP_BEHIND_ORBITS * period;
      const merged: Record<string, Trajectory> = { ...cur.trajectories };
      for (const c of chunks ?? []) {
        const existing = merged[c.object_id];
        merged[c.object_id] = existing ? trimTrajectory(mergeTrajectory(existing, c), keepFrom) : c;
      }
      set({
        trajectories: merged,
        dataWindow: { startUnix: Math.max(cur.dataWindow.startUnix, keepFrom), endUnix: Math.max(cur.dataWindow.endUnix, end) },
        rollingLoading: false,
        dataStall: false,
      });
      if (get().pausedForData) {
        set({ pausedForData: false });
        controller.play();
      }
    } catch (e) {
      set({ rollingLoading: false, rollingRetryAtMs: performance.now() + 5000, notice: `Orbit data could not be extended: ${errMsg(e)}` });
    } finally {
      if (get().rollingLoading) set({ rollingLoading: false });
    }
  },

  refreshPrimaryTrajectory: async () => {
    const s = get();
    if (!s.scenario || !s.dataWindow) return;
    const scenarioId = s.scenario.scenario_id;
    const primaryId = s.scenario.primary_id;
    const step = stepFor(s.scenario.kind);
    try {
      let fetched = await api.trajectory(scenarioId, primaryId, { start: isoOf(s.dataWindow.startUnix), end: isoOf(s.dataWindow.endUnix), step_s: step });
      let cur = get();
      if (cur.scenario?.scenario_id !== scenarioId) return;
      // the rolling window may have grown meanwhile: fetch the tail too
      let fetchedEnd = fetched.times_unix[fetched.times_unix.length - 1] ?? s.dataWindow.endUnix;
      for (let guard = 0; guard < 3 && cur.dataWindow && cur.dataWindow.endUnix > fetchedEnd + step; guard++) {
        const tail = await api.trajectory(scenarioId, primaryId, { start: isoOf(fetchedEnd), end: isoOf(cur.dataWindow.endUnix), step_s: step });
        fetched = mergeTrajectory(fetched, tail);
        fetchedEnd = fetched.times_unix[fetched.times_unix.length - 1] ?? fetchedEnd;
        cur = get();
        if (cur.scenario?.scenario_id !== scenarioId) return;
      }
      set({ trajectories: { ...cur.trajectories, [primaryId]: fetched } });
    } catch (e) {
      set({ notice: `The spacecraft's new path could not be loaded: ${errMsg(e)}` });
    }
  },

  // ---------------------------------------------------------------- ghosts
  syncGhosts: () => {
    const s = get();
    if (!s.scenario) return;
    const next = ghostsFromCommitted(s.simulation?.committed_maneuvers, s.ghosts, detectionRadii(s.scenario.thresholds).criticalKm, s.objects);
    if (next !== s.ghosts) {
      const keep = s.insetTarget === 'primary' || next.some((g) => g.id === s.insetTarget);
      set({ ghosts: next, insetTarget: keep ? s.insetTarget : 'primary' });
    }
    for (const g of next) {
      if ((g.status === 'loading' && g.attempts === 0) || (g.status === 'failed' && g.attempts < GHOST_MAX_ATTEMPTS)) void get().fetchGhostTrajectory(g.id);
    }
  },

  fetchGhostTrajectory: async (id) => {
    const s = get();
    const ghost = s.ghosts.find((g) => g.id === id);
    if (!s.scenario || !ghost) return;
    const scenarioId = s.scenario.scenario_id;
    const resetCount = s.scenario.simulation.reset_count;
    // a switch, a reset or a withdrawal while the request is in flight makes its answer stale
    const patch = (fields: Partial<Ghost>): boolean => {
      const cur = get();
      if (cur.scenario?.scenario_id !== scenarioId || cur.scenario.simulation.reset_count !== resetCount) return false;
      if (!cur.ghosts.some((g) => g.id === id)) return false;
      set({ ghosts: cur.ghosts.map((g) => (g.id === id ? { ...g, ...fields } : g)) });
      return true;
    };
    patch({ status: 'loading', attempts: ghost.attempts + 1 });
    const range = ghostFetchRange(ghost);
    try {
      const trajectory = await api.trajectory(scenarioId, s.scenario.primary_id, {
        variant: 'before_burn', maneuver_id: id, start: isoOf(range.startUnix), end: isoOf(range.endUnix), step_s: stepFor(s.scenario.kind),
      });
      patch({ trajectory, status: 'ready', crashPointTeme: ghost.crashPointTeme ?? crashPointOf({ ...ghost, trajectory }) });
    } catch (e) {
      if (patch({ status: 'failed' })) set({ notice: `The ghost's course could not be loaded: ${errMsg(e)}` });
    }
  },

  setInsetTarget: (target) => {
    const s = get();
    set({ insetTarget: target === 'primary' || s.ghosts.some((g) => g.id === target) ? target : 'primary' });
  },

  // ---------------------------------------------------------------- sandbox
  evaluateSandbox: async (trigger) => {
    const s = get();
    if (!s.sandbox.enabled || !s.scenario) return;
    if (s.sandbox.evaluateInFlight) {
      if (trigger !== 'tick') set({ sandbox: { ...get().sandbox, pendingEvaluate: true } });
      return;
    }
    const scenarioId = s.scenario.scenario_id;
    const resetCount = s.scenario.simulation.reset_count;
    const now = controller.currentUnix;
    const before = s.simulation?.committed_maneuvers?.length ?? 0;
    set({ sandbox: { ...s.sandbox, evaluateInFlight: true, pendingEvaluate: false, lastEvaluateRealMs: performance.now() } });
    try {
      const res = await api.sandboxEvaluate(scenarioId, isoOf(now), earliestBurnAfterS(controller.speed));
      const cur = get();
      if (cur.scenario?.scenario_id !== scenarioId || cur.scenario.simulation.reset_count !== resetCount) return;
      const screening = screeningFromEvaluate(cur.scenario, res.conjunctions, res.screening.stats, res.simulation);
      const committed = res.simulation.committed_maneuvers ?? [];
      const announced = [...cur.sandbox.announced];
      const notices: string[] = [];
      for (const a of res.actions) {
        if (a.outcome === 'COMMITTED' && a.maneuver_id && a.burn_time) {
          notices.push(`Autopilot: burn ${a.direction ?? ''} ${(a.dv_mps ?? 0).toFixed(2)} m/s at ${a.burn_time.slice(11, 19)} UTC, pass widens to ${(a.post_miss_km ?? 0).toFixed(1)} km`);
        } else if (a.outcome === 'UNAVOIDABLE' && !announced.includes(a.conjunction_id)) {
          announced.push(a.conjunction_id);
          notices.push(`Could not avoid ${a.secondary_id}: ${a.reason ?? 'no burn found'}`);
        }
      }
      const keepSelection = cur.selectedConjunctionId && screening.conjunctions.some((c) => c.conjunction_id === cur.selectedConjunctionId && c.tca_unix > now - PASS_DONE_S);
      set({
        screening,
        simulation: res.simulation,
        selectedConjunctionId: keepSelection ? cur.selectedConjunctionId : nextThreat(screening.conjunctions, res.simulation.burn_times_unix ?? [], now),
        sandbox: {
          ...cur.sandbox,
          autopilot: res.simulation.autopilot,
          spawnedIds: res.simulation.spawned_object_ids ?? cur.sandbox.spawnedIds,
          lastEvaluatedUnix: now,
          screeningEndUnix: new Date(res.screening.end).getTime() / 1000,
          lastActions: res.actions,
          announced,
        },
        ...(notices.length ? { notice: notices[0] } : {}),
      });
      get().syncGhosts();
      if (committed.length !== before) await get().refreshPrimaryTrajectory();
      // autopilot off: the planned burn waits in the decision panel
      const waiting = res.actions.find((a) => a.outcome === 'AWAITING_APPROVAL' && a.maneuver_id);
      if (waiting && !get().plan?.candidates.some((c) => c.maneuver_id === waiting.maneuver_id)) {
        try {
          const plan = await api.existingPlan(scenarioId, waiting.conjunction_id);
          await hydratePlan(set, get, plan, waiting.maneuver_id);
        } catch {
          /* planned burn unavailable */
        }
      }
    } catch (e) {
      set({ notice: `Autopilot evaluation failed: ${errMsg(e)}`, sandbox: { ...get().sandbox, lastEvaluateRealMs: performance.now() + 20_000 } });
    } finally {
      const pending = get().sandbox.pendingEvaluate;
      set({ sandbox: { ...get().sandbox, evaluateInFlight: false, pendingEvaluate: false } });
      if (pending) void get().evaluateSandbox('manual');
    }
  },

  spawnJunk: async (kind, opts = {}) => {
    const s = get();
    if (!s.sandbox.enabled || !s.scenario || !s.dataWindow || s.sandbox.spawnInFlight) return;
    const scenarioId = s.scenario.scenario_id;
    const now = controller.currentUnix;
    set({ sandbox: { ...s.sandbox, spawnInFlight: true } });
    try {
      const res = await api.sandboxSpawn(scenarioId, isoOf(now), kind, { time_to_tca_s: opts.timeToTcaS !== undefined ? Math.max(180, Math.round(opts.timeToTcaS)) : undefined });
      const cur = get();
      if (cur.scenario?.scenario_id !== scenarioId) return;
      const id = res.object.object_id;
      set({ objects: { ...cur.objects, [id]: res.object }, simulation: res.simulation, sandbox: { ...cur.sandbox, spawnedIds: res.simulation.spawned_object_ids ?? [...cur.sandbox.spawnedIds, id] } });
      const t = await api.trajectory(scenarioId, id, { start: isoOf(now), end: isoOf(Math.max(get().dataWindow?.endUnix ?? now, now + 600)), step_s: STEP_SYNTHETIC_S });
      if (get().scenario?.scenario_id !== scenarioId) return;
      const km = res.designed.miss_km < 1 ? `${Math.round(res.designed.miss_km * 1000)} m` : `${res.designed.miss_km.toFixed(1)} km`;
      set({
        trajectories: { ...get().trajectories, [id]: t },
        notice: `Spawned ${junkKindInfo(kind).label.toLowerCase()} ${id}: closest approach in ${Math.round(res.designed.time_to_tca_s / 60)} min at ${km}`,
      });
    } catch (e) {
      set({ notice: `Could not spawn junk: ${errMsg(e)}` });
    } finally {
      set({ sandbox: { ...get().sandbox, spawnInFlight: false } });
    }
    void get().evaluateSandbox('spawn');
  },

  spawnRandom: async (count) => {
    const s = get();
    if (!s.sandbox.enabled || !s.scenario || !s.dataWindow || s.sandbox.spawnInFlight) return;
    const scenarioId = s.scenario.scenario_id;
    const now = controller.currentUnix;
    set({ sandbox: { ...s.sandbox, spawnInFlight: true } });
    try {
      const res = await api.sandboxSpawnRandom(scenarioId, isoOf(now), Math.min(20, Math.max(1, Math.round(count))));
      const cur = get();
      if (cur.scenario?.scenario_id !== scenarioId) return;
      const ids = res.objects.map((o) => o.object_id);
      set({ objects: { ...cur.objects, ...byId(res.objects) }, simulation: res.simulation, sandbox: { ...cur.sandbox, spawnedIds: res.simulation.spawned_object_ids ?? [...cur.sandbox.spawnedIds, ...ids] } });
      const { trajectories } = await api.trajectories(scenarioId, ids, STEP_SYNTHETIC_S, isoOf(now), isoOf(Math.max(get().dataWindow?.endUnix ?? now, now + 600)));
      if (get().scenario?.scenario_id !== scenarioId) return;
      set({ trajectories: { ...get().trajectories, ...byId(trajectories ?? []) }, notice: `Spawned ${ids.length} pieces of junk around the next two orbits.` });
    } catch (e) {
      set({ notice: `Could not spawn junk: ${errMsg(e)}` });
    } finally {
      set({ sandbox: { ...get().sandbox, spawnInFlight: false } });
    }
    void get().evaluateSandbox('spawn');
  },

  setAutopilot: async (on) => {
    const s = get();
    if (!s.sandbox.enabled || !s.scenario) return;
    try {
      const sim = await api.setAutopilot(s.scenario.scenario_id, on);
      set({ simulation: sim, sandbox: { ...get().sandbox, autopilot: sim.autopilot }, notice: sim.autopilot ? 'Autopilot engaged: the simulation commits avoidance burns itself.' : 'Autopilot off: planned burns wait for your approval.' });
      if (sim.autopilot) void get().evaluateSandbox('autopilot');
    } catch (e) {
      set({ notice: `Autopilot setting failed: ${errMsg(e)}` });
    }
  },

  removeJunk: async (count) => {
    const s = get();
    if (!s.sandbox.enabled || !s.scenario || s.sandbox.spawnInFlight || count < 1) return;
    const scenarioId = s.scenario.scenario_id;
    set({ sandbox: { ...s.sandbox, spawnInFlight: true } });
    try {
      const res = await api.sandboxRemove(scenarioId, isoOf(controller.currentUnix), { count: Math.round(count) });
      const cur = get();
      if (cur.scenario?.scenario_id !== scenarioId) return;
      const gone = new Set(res.removed);
      const objects = { ...cur.objects };
      const trajectories = { ...cur.trajectories };
      for (const id of res.removed) {
        delete objects[id];
        delete trajectories[id];
      }
      const selectedGone = cur.selectedObjectId ? gone.has(cur.selectedObjectId) : false;
      const conjGone = cur.selectedConjunction() ? gone.has(cur.selectedConjunction()!.secondary_id) : false;
      const ghosts = cur.ghosts.filter((g) => !gone.has(g.secondaryId));
      set({
        objects,
        trajectories,
        simulation: res.simulation,
        ghosts: ghosts.length === cur.ghosts.length ? cur.ghosts : ghosts,
        insetTarget: cur.insetTarget === 'primary' || ghosts.some((g) => g.id === cur.insetTarget) ? cur.insetTarget : 'primary',
        screening: cur.screening ? { ...cur.screening, conjunctions: cur.screening.conjunctions.filter((c) => !gone.has(c.secondary_id)) } : cur.screening,
        selectedObjectId: selectedGone ? null : cur.selectedObjectId,
        objectDetail: selectedGone ? null : cur.objectDetail,
        selectedConjunctionId: conjGone ? null : cur.selectedConjunctionId,
        sandbox: { ...cur.sandbox, spawnedIds: res.simulation.spawned_object_ids ?? cur.sandbox.spawnedIds.filter((id) => !gone.has(id)) },
        notice: res.removed.length ? `Removed ${res.removed.length} piece${res.removed.length === 1 ? '' : 's'} of junk from orbit.` : 'Nothing to remove.',
      });
    } catch (e) {
      set({ notice: `Could not remove junk: ${errMsg(e)}` });
    } finally {
      set({ sandbox: { ...get().sandbox, spawnInFlight: false } });
    }
    void get().evaluateSandbox('spawn');
  },
  setRandomCount: (n) => set({ sandbox: { ...get().sandbox, randomCount: Math.min(20, Math.max(1, Math.round(n) || 1)) } }),
}));

async function hydratePlan(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  plan: PlanResponse,
  preferredManeuverId: string | null,
): Promise<void> {
  const { scenarioId, scenario, dataWindow } = get();
  const ids = [...plan.recommended_ids];
  if (preferredManeuverId && !ids.includes(preferredManeuverId)) ids.push(preferredManeuverId);
  const existing = get().candidateTrajectories;
  const range = dataWindow ? { start: isoOf(dataWindow.startUnix), end: isoOf(dataWindow.endUnix) } : {};
  // Candidates planned against an earlier version of the primary (before a burn was committed) cannot be
  // previewed on the committed path any more; the backend refuses them, so do not ask.
  const sim = get().simulation;
  const committed = new Set((sim?.committed_maneuvers ?? []).map((m) => m.maneuver_id));
  const stale = (mid: string) => {
    const cand = plan.candidates.find((c) => c.maneuver_id === mid);
    return !!sim && !!cand && !committed.has(mid) && cand.primary_version != null && cand.primary_version !== sim.primary_version;
  };
  const fetched = await Promise.all(
    ids.map(async (mid) => {
      if (existing[mid]) return [mid, existing[mid]] as const;
      if (stale(mid)) return [mid, null] as const;
      try {
        return [mid, await api.trajectory(scenarioId, scenario!.primary_id, { maneuver_id: mid, step_s: stepFor(scenario!.kind), ...range })] as const;
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
