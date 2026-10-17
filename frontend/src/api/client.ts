import type {
  AgentRun,
  Conjunction,
  DecisionResponse,
  HealthResponse,
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

export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000').replace(/\/$/, '');

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new ApiError(0, `Backend unreachable at ${API_BASE} (${(err as Error).message})`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body?.detail === 'string') detail = body.detail;
      else if (body?.detail) detail = JSON.stringify(body.detail);
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),
  scenarios: () => request<ScenarioSummary[]>('/api/scenarios'),
  scenario: (id: string) => request<ScenarioDetail>(`/api/scenarios/${encodeURIComponent(id)}`),
  resetScenario: (id: string, live = false) =>
    request<ScenarioDetail>(`/api/scenarios/${encodeURIComponent(id)}/reset${qs({ live: live ? 'true' : undefined })}`, {
      method: 'POST',
    }),
  objects: (scenarioId: string) =>
    request<{ scenario_id: string; primary_id: string; objects: ObjectSummary[] }>(`/api/objects${qs({ scenario_id: scenarioId })}`),
  objectDetail: (scenarioId: string, objectId: string, at?: string) =>
    request<ObjectDetail>(`/api/objects/${encodeURIComponent(objectId)}${qs({ scenario_id: scenarioId, at })}`),
  trajectory: (scenarioId: string, objectId: string, opts: { start?: string; end?: string; step_s?: number; maneuver_id?: string } = {}) =>
    request<Trajectory>(
      `/api/objects/${encodeURIComponent(objectId)}/trajectory${qs({ scenario_id: scenarioId, ...opts })}`,
    ),
  trajectories: (scenarioId: string, objectIds: string[], step_s = 60, start?: string, end?: string) =>
    request<{ trajectories: Trajectory[] }>('/api/objects/trajectories', {
      method: 'POST',
      body: JSON.stringify({ scenario_id: scenarioId, object_ids: objectIds, step_s, start, end }),
    }),
  screen: (scenarioId: string, opts: { pc_policy?: string; primary_id?: string } = {}) =>
    request<ScreenResponse>('/api/conjunctions/screen', {
      method: 'POST',
      body: JSON.stringify({ scenario_id: scenarioId, ...opts }),
    }),
  conjunctions: (scenarioId: string) => request<ScreenResponse>(`/api/conjunctions${qs({ scenario_id: scenarioId })}`),
  existingPlan: (scenarioId: string, conjunctionId: string) =>
    request<PlanResponse>(`/api/conjunctions/${encodeURIComponent(conjunctionId)}/maneuvers${qs({ scenario_id: scenarioId })}`),
  conjunction: (scenarioId: string, id: string) =>
    request<Conjunction>(`/api/conjunctions/${encodeURIComponent(id)}${qs({ scenario_id: scenarioId })}`),
  planManeuvers: (scenarioId: string, conjunctionId: string, maxCandidates = 3) =>
    request<PlanResponse>(`/api/conjunctions/${encodeURIComponent(conjunctionId)}/maneuvers`, {
      method: 'POST',
      body: JSON.stringify({ scenario_id: scenarioId, max_candidates: maxCandidates }),
    }),
  secondaryCheck: (scenarioId: string, maneuverId: string) =>
    request<SecondaryCheckResponse>(`/api/maneuvers/${encodeURIComponent(maneuverId)}/secondary-check`, {
      method: 'POST',
      body: JSON.stringify({ scenario_id: scenarioId }),
    }),
  analyze: (scenarioId: string, conjunctionId?: string, mode?: string) =>
    request<AgentRun>('/api/agent/analyze', {
      method: 'POST',
      body: JSON.stringify({ scenario_id: scenarioId, conjunction_id: conjunctionId, mode }),
    }),
  simulationState: (scenarioId: string) => request<SimulationState>(`/api/simulation/state${qs({ scenario_id: scenarioId })}`),
  approve: (scenarioId: string, maneuverId: string) =>
    request<DecisionResponse>('/api/simulation/approve', {
      method: 'POST',
      body: JSON.stringify({ scenario_id: scenarioId, maneuver_id: maneuverId }),
    }),
  reject: (scenarioId: string, maneuverId: string, reason?: string) =>
    request<DecisionResponse>('/api/simulation/reject', {
      method: 'POST',
      body: JSON.stringify({ scenario_id: scenarioId, maneuver_id: maneuverId, reason }),
    }),
};
