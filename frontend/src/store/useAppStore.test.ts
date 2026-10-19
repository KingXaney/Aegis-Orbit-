import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { controller } from '../simulation/controller';
import { GHOST_HOLD_S, type Ghost } from '../simulation/ghosts';
import type { AvoidedPass, CommittedManeuver, ScenarioDetail, SimulationState, Trajectory } from '../types/api';
import { useAppStore } from './useAppStore';

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, api: { ...actual.api, trajectory: vi.fn() } };
});

const trajectoryMock = vi.mocked(api.trajectory);

const BURN = 1000;
const CRASH = 2000;

function scenario(resetCount = 0): ScenarioDetail {
  return {
    scenario_id: 'synthetic-conjunction', kind: 'synthetic', primary_id: 'SYN-GPM', rendered_object_ids: ['SYN-GPM', 'SYN-DEB-2047'],
    window: { start: '', end: '', start_unix: 0, end_unix: 21600 }, thresholds: { miss_distance_target_km: 5, screening_radius_km: 25 },
    simulation: { reset_count: resetCount },
  } as unknown as ScenarioDetail;
}

function avoided(): AvoidedPass {
  return { conjunction_id: 'CJ-SYN-GPM-SYN-DEB-2047-2000', secondary_id: 'SYN-DEB-2047', secondary_name: 'DEB-2047', tca: '', tca_unix: CRASH, miss_km: 0.354, relative_speed_kms: 8.2, threat_state: 'CRITICAL', ghost_r_km: [7000, 0, 0], secondary_r_km: [7000.3, 0, 0], basis: 'screening' };
}

function burn(id: string): CommittedManeuver {
  return { maneuver_id: id, burn_time_unix: BURN, post_miss_distance_km: 6.6, avoided_pass: avoided() } as unknown as CommittedManeuver;
}

function simulation(...burns: CommittedManeuver[]): SimulationState {
  return { reset_count: 0, committed_maneuvers: burns, burn_times_unix: burns.map((b) => b.burn_time_unix) } as unknown as SimulationState;
}

const path = { object_id: 'SYN-GPM', times_unix: [BURN - 120, CRASH, CRASH + 120], positions_km: [[6999, 0, 0], [7000, 0, 0], [7001, 0, 0]], velocities_kms: [[0.01, 0, 0], [0.01, 0, 0], [0.01, 0, 0]], variant: 'before_burn' } as unknown as Trajectory;

const tick = (currentUnix: number, over: Partial<{ openEnded: boolean; speed: number }> = {}) =>
  useAppStore.getState().liveTick({ startUnix: 0, endUnix: 21600, openEnded: false, currentUnix, playing: true, speed: 60, ...over });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  trajectoryMock.mockResolvedValue(path);
  controller.setSpeed(60);
  useAppStore.setState({
    scenarioId: 'synthetic-conjunction', scenario: scenario(), simulation: simulation(burn('m1')),
    objects: { 'SYN-GPM': { object_id: 'SYN-GPM' }, 'SYN-DEB-2047': { object_id: 'SYN-DEB-2047' } } as never,
    ghosts: [], insetTarget: 'primary', ghostAutoSwitched: null, autoSlow: null, autoSlowSkip: null, slowForPasses: true, notice: null,
  });
});

afterEach(() => {
  useAppStore.setState({ scenario: null, simulation: null, ghosts: [], insetTarget: 'primary', ghostAutoSwitched: null, autoSlow: null, autoSlowSkip: null });
  vi.clearAllMocks();
});

describe('syncGhosts', () => {
  it('makes a ghost per committed burn, fetches its course once and keeps it across simulation refreshes', async () => {
    useAppStore.getState().syncGhosts();
    expect(useAppStore.getState().ghosts).toMatchObject([{ id: 'm1', bornUnix: BURN, crashUnix: CRASH, status: 'loading', attempts: 1 }]);
    await vi.waitFor(() => expect(useAppStore.getState().ghosts[0].status).toBe('ready'));
    expect(trajectoryMock).toHaveBeenCalledTimes(1);
    expect(trajectoryMock).toHaveBeenCalledWith('synthetic-conjunction', 'SYN-GPM', expect.objectContaining({ variant: 'before_burn', maneuver_id: 'm1', step_s: 60 }));
    const loaded = useAppStore.getState().ghosts;
    // the backend replaces the simulation state often: same burn, new array
    useAppStore.setState({ simulation: simulation(burn('m1')) });
    useAppStore.getState().syncGhosts();
    expect(useAppStore.getState().ghosts).toBe(loaded);
    expect(trajectoryMock).toHaveBeenCalledTimes(1);
    // the burn is withdrawn: the ghost goes, and so does the close-up's hold on it
    useAppStore.setState({ insetTarget: 'm1', simulation: simulation() });
    useAppStore.getState().syncGhosts();
    expect(useAppStore.getState().ghosts).toEqual([]);
    expect(useAppStore.getState().insetTarget).toBe('primary');
  });

  it('discards a course that arrives after a reset', async () => {
    const d = deferred<Trajectory>();
    trajectoryMock.mockReturnValueOnce(d.promise);
    useAppStore.getState().syncGhosts();
    useAppStore.setState({ scenario: scenario(1) });
    d.resolve(path);
    await Promise.resolve();
    await Promise.resolve();
    expect(useAppStore.getState().ghosts[0]).toMatchObject({ status: 'loading', trajectory: null });
  });
});

describe('liveTick with ghosts', () => {
  const ready = (): Ghost => ({
    id: 'm1', index: 1, bornUnix: BURN, crashUnix: CRASH, missKm: 0.354, postMissKm: 6.6, secondaryId: 'SYN-DEB-2047', secondaryName: 'DEB-2047',
    relativeSpeedKms: 8.2, criticalRadiusKm: 5, crashPointTeme: [7000, 0, 0], trajectory: path, status: 'ready', attempts: 1,
  });

  it('follows the ghost once when it is born, slows the clock before the collision, and keeps it on a bounded clock', () => {
    useAppStore.setState({ ghosts: [ready()] });
    tick(BURN - 10);
    expect(useAppStore.getState().insetTarget).toBe('primary');
    tick(BURN + 1);
    expect(useAppStore.getState().insetTarget).toBe('m1');
    expect(useAppStore.getState().ghostAutoSwitched).toBe('m1');
    // the user moves the close-up back by hand: it is not switched again
    useAppStore.getState().setInsetTarget('primary');
    tick(CRASH - 200);
    expect(controller.speed).toBe(60);
    expect(useAppStore.getState().insetTarget).toBe('primary');
    tick(CRASH - 30);
    expect(controller.speed).toBe(10);
    expect(useAppStore.getState().autoSlow).toMatchObject({ kind: 'ghost', eventId: 'ghost:m1', restoreSpeed: 60 });
    // nor when the collision nears
    expect(useAppStore.getState().insetTarget).toBe('primary');
    tick(CRASH - 5, { speed: 10 });
    expect(controller.speed).toBe(1);
    expect(useAppStore.getState().insetTarget).toBe('primary');
    tick(CRASH + GHOST_HOLD_S + 1, { speed: 1 });
    expect(useAppStore.getState().autoSlow).toBeNull();
    expect(controller.speed).toBe(60);
    expect(useAppStore.getState().ghosts).toHaveLength(1); // bounded clocks can scrub back to it
  });

  it('deletes a gone ghost on the open-ended clock and lets go of it in the close-up', () => {
    useAppStore.setState({ ghosts: [ready()], insetTarget: 'm1' });
    tick(CRASH + 2, { openEnded: true });
    expect(useAppStore.getState().ghosts).toHaveLength(1);
    expect(useAppStore.getState().insetTarget).toBe('m1');
    tick(CRASH + GHOST_HOLD_S + 1, { openEnded: true });
    expect(useAppStore.getState().ghosts).toEqual([]);
    expect(useAppStore.getState().insetTarget).toBe('primary');
  });

  it('leaves the speed alone when slow motion is switched off', () => {
    useAppStore.setState({ ghosts: [ready()], slowForPasses: false });
    tick(CRASH - 30);
    expect(controller.speed).toBe(60);
    expect(useAppStore.getState().autoSlow).toBeNull();
  });
});

describe('agent runs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends the scenario and selected conjunction with the analyze request', async () => {
    const analyze = vi.spyOn(api, 'analyze').mockRejectedValue(new Error('offline'));
    useAppStore.setState({ scenarioId: 'synthetic-conjunction', selectedConjunctionId: null });
    await useAppStore.getState().runAgent();
    expect(analyze).toHaveBeenLastCalledWith('synthetic-conjunction', undefined);
  });
});
