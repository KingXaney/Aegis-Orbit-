import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store/useAppStore';
import type { ScenarioDetail } from '../types/api';
import { perceptionApi } from './api';
import { IDLE, LAST_STEP, STEP } from './funnel';
import { STEP_MS, startPerceptionSync, usePerceptionStore } from './store';
import type { PerceptionResponse } from './types';

vi.mock('./api', () => ({ perceptionApi: { perceive: vi.fn(), catalogTles: vi.fn(), drill: vi.fn() } }));

const api = vi.mocked(perceptionApi);

function scenario(id: string, kind: ScenarioDetail['kind'], resetCount = 0, shortlist = kind === 'real'): ScenarioDetail {
  return {
    scenario_id: id,
    kind,
    primary_id: 'NORAD-25544',
    rendered_object_ids: ['NORAD-25544', 'NORAD-1'],
    window: { start: '', end: '', start_unix: 0, end_unix: 86400 },
    simulation: { reset_count: resetCount },
    screening_shortlist: shortlist ? { size: 374 } : null,
  } as unknown as ScenarioDetail;
}

const perception = { scenario_id: 'real-iss', objects: [], funnel: null } as unknown as PerceptionResponse;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  api.catalogTles.mockResolvedValue({ scenario_id: 'real-iss', primary_id: 'NORAD-25544', count: 1, fields: [], rows: [['NORAD-1', 'A', 'DEBRIS', '1 x', '2 x']], source: null, retrieved_at: null });
  useAppStore.setState({ scenario: null, layers: { ...useAppStore.getState().layers, background: true } });
  usePerceptionStore.setState(usePerceptionStore.getInitialState());
  stop = startPerceptionSync();
});

afterEach(() => {
  // leave the module's layer bookkeeping clean for the next test
  useAppStore.setState({ scenario: null });
  stop();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('scenario sync', () => {
  it('activates on the full-catalog real scenario, loads the cloud rows and hides the tracked-objects layer until the funnel confirms', async () => {
    useAppStore.setState({ scenario: scenario('real-iss', 'real') });
    expect(usePerceptionStore.getState().active).toBe(true);
    expect(useAppStore.getState().layers.background).toBe(false);
    await vi.waitFor(() => expect(usePerceptionStore.getState().rows).toHaveLength(1));
    expect(api.catalogTles).toHaveBeenCalledWith('real-iss');
  });

  it('stays inactive elsewhere and gives the tracked-objects layer back when leaving', () => {
    useAppStore.setState({ scenario: scenario('real-iss', 'real') });
    useAppStore.setState({ scenario: scenario('synthetic-conjunction', 'synthetic') });
    expect(usePerceptionStore.getState().active).toBe(false);
    expect(useAppStore.getState().layers.background).toBe(true);
    // the 400-object real fixture has no shortlist: no funnel either
    useAppStore.setState({ scenario: scenario('real-iss', 'real', 0, false) });
    expect(usePerceptionStore.getState().active).toBe(false);
  });
});

describe('run', () => {
  beforeEach(() => {
    useAppStore.setState({ scenario: scenario('real-iss', 'real') });
  });

  it('plays every step, then turns the tracked-objects layer back on', async () => {
    api.perceive.mockResolvedValue(perception);
    await usePerceptionStore.getState().run();
    expect(usePerceptionStore.getState()).toMatchObject({ step: STEP.tracked, playing: true, perception });
    vi.advanceTimersByTime(STEP_MS * 2);
    expect(usePerceptionStore.getState().step).toBe(STEP.screened);
    expect(useAppStore.getState().layers.background).toBe(false);
    vi.advanceTimersByTime(STEP_MS * 3);
    expect(usePerceptionStore.getState()).toMatchObject({ step: LAST_STEP, playing: false });
    expect(useAppStore.getState().layers.background).toBe(true);
  });

  it('skips to the end', async () => {
    api.perceive.mockResolvedValue(perception);
    await usePerceptionStore.getState().run();
    usePerceptionStore.getState().skip();
    expect(usePerceptionStore.getState()).toMatchObject({ step: LAST_STEP, playing: false });
    vi.advanceTimersByTime(STEP_MS * 10);
    expect(usePerceptionStore.getState().step).toBe(LAST_STEP);
  });

  it('clears the funnel when a run fails', async () => {
    api.perceive.mockResolvedValueOnce(perception);
    await usePerceptionStore.getState().run();
    usePerceptionStore.getState().skip();
    api.perceive.mockRejectedValueOnce(new Error('backend down'));
    await usePerceptionStore.getState().run();
    expect(usePerceptionStore.getState()).toMatchObject({ error: 'backend down', perception: null, step: IDLE, loading: false });
  });

  it('drops the answer of a run that a reset overtook', async () => {
    const d = deferred<PerceptionResponse>();
    api.perceive.mockReturnValue(d.promise);
    const running = usePerceptionStore.getState().run();
    useAppStore.setState({ scenario: scenario('real-iss', 'real', 1) });
    d.resolve(perception);
    await running;
    expect(usePerceptionStore.getState()).toMatchObject({ perception: null, step: IDLE, loading: false, resetCount: 1 });
  });
});

describe('injectDrill', () => {
  beforeEach(() => {
    useAppStore.setState({ scenario: scenario('real-iss', 'real') });
  });

  it('reports a refused drill', async () => {
    api.drill.mockRejectedValue(new Error('a drill is already running'));
    await usePerceptionStore.getState().injectDrill();
    expect(usePerceptionStore.getState()).toMatchObject({ drillLoading: false, drillError: 'a drill is already running' });
  });

  it('writes nothing into a scenario that was reset while the drill was in flight', async () => {
    const d = deferred<Awaited<ReturnType<typeof perceptionApi.drill>>>();
    api.drill.mockReturnValue(d.promise);
    const before = useAppStore.getState().objects;
    const injecting = usePerceptionStore.getState().injectDrill();
    useAppStore.setState({ scenario: scenario('real-iss', 'real', 1) });
    d.resolve({ object: { object_id: 'DRILL-1' } } as Awaited<ReturnType<typeof perceptionApi.drill>>);
    await injecting;
    expect(useAppStore.getState().objects).toBe(before);
    expect(usePerceptionStore.getState()).toMatchObject({ drillLoading: false, drillError: null });
  });
});
