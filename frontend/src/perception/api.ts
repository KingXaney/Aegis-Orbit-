import { API_BASE, ApiError } from '../api/client';
import type { CatalogTlesResponse, DrillResponse, PerceptionResponse } from './types';

// The three perception endpoints, kept beside the funnel so api/client.ts stays as it is.

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
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

const sid = (id: string) => encodeURIComponent(id);

export const perceptionApi = {
  /** Without trails: the funnel needs tiers and counts, not the relative-motion samples. */
  perceive: (scenarioId: string) => call<PerceptionResponse>(`/api/perception?scenario_id=${sid(scenarioId)}&trails=false`),
  catalogTles: (scenarioId: string) => call<CatalogTlesResponse>(`/api/scenarios/${sid(scenarioId)}/catalog-tles`),
  drill: (scenarioId: string, now: string) =>
    call<DrillResponse>(`/api/scenarios/${sid(scenarioId)}/drill`, { method: 'POST', body: JSON.stringify({ now }) }),
};
