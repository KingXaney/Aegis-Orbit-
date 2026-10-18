import { describe, expect, it } from 'vitest';
import { CHUNK_ORBITS, MAX_SAMPLES, extensionNeeded, mergeTrajectory, nextChunk, stalled, trimTrajectory } from './rolling';
import type { Trajectory } from '../types/api';

function traj(times: number[], extra: Partial<Trajectory> = {}): Trajectory {
  return {
    object_id: 'X', scenario_id: 's', frame: 'TEME', units: {}, model: 'NUMERICAL_J2', position_basis: 'test', source_epoch: null,
    start: new Date(times[0] * 1000).toISOString(), end: new Date(times[times.length - 1] * 1000).toISOString(), step_s: 60,
    times_unix: times, positions_km: times.map((t) => [t, 0, 0]), velocities_kms: times.map(() => [0, 1, 0]),
    status: 'OK', messages: [], segments: [{ start: '', end: '', model: 'NUMERICAL_J2', label: 'a' }], maneuver_id: null, burn_time: null,
    ...extra,
  };
}

describe('extensionNeeded / nextChunk / stalled', () => {
  it('asks for more data within an orbit of the end, or sooner at high speed', () => {
    expect(extensionNeeded(1000, 60, 1000 + 7000, 5600)).toBe(false);
    expect(extensionNeeded(1000, 60, 1000 + 5000, 5600)).toBe(true);
    expect(extensionNeeded(1000, 1800, 1000 + 20_000, 5600)).toBe(true); // 1800x needs 36 000 s of lead
    expect(extensionNeeded(1000, 1800, 1000 + 40_000, 5600)).toBe(false);
  });

  it('sizes chunks by orbits, grows them with speed and caps them at the backend limit', () => {
    expect(nextChunk(5000, 5600, 60, 60)).toEqual({ start: 5000, end: 5000 + CHUNK_ORBITS * 5600 });
    expect(nextChunk(5000, 5600, 1800, 60).end - 5000).toBe(2 * 1800 * 20);
    expect(nextChunk(0, 5600, 1e9, 60).end).toBe(MAX_SAMPLES * 60);
  });

  it('reports a stall when the clock reaches the loaded end', () => {
    expect(stalled(999, 1000)).toBe(false);
    expect(stalled(999.5, 1000)).toBe(true);
    expect(stalled(1001, 1000)).toBe(true);
  });
});

describe('mergeTrajectory', () => {
  it('appends the chunk without duplicating the shared end sample', () => {
    const a = traj([0, 60, 120], { burn_times_unix: [30] });
    const b = traj([120, 180, 240], { burn_times_unix: [30, 200], messages: ['late'] });
    const m = mergeTrajectory(a, b);
    expect(m.times_unix).toEqual([0, 60, 120, 180, 240]);
    expect(m.positions_km).toHaveLength(5);
    expect(m.velocities_kms).toHaveLength(5);
    expect(m.segments).toHaveLength(2);
    expect(m.burn_times_unix).toEqual([30, 200]);
    expect(m.messages).toEqual(['late']);
    expect(m.end).toBe(b.end);
    expect(m.status).toBe('OK');
  });

  it('returns the existing record when the chunk adds nothing', () => {
    const a = traj([0, 60, 120]);
    expect(mergeTrajectory(a, traj([60, 120]))).toBe(a);
  });

  it('marks a partially failed chunk', () => {
    const m = mergeTrajectory(traj([0, 60]), traj([60, 120], { status: 'PARTIAL' }));
    expect(m.status).toBe('PARTIAL');
  });
});

describe('trimTrajectory', () => {
  it('keeps one sample before the cut so interpolation across it stays valid', () => {
    const t = traj([0, 60, 120, 180, 240]);
    const cut = trimTrajectory(t, 130);
    expect(cut.times_unix).toEqual([120, 180, 240]);
    expect(cut.positions_km).toHaveLength(3);
    expect(cut.start).toBe(new Date(120 * 1000).toISOString());
    expect(trimTrajectory(t, 120).times_unix).toEqual([120, 180, 240]);
  });

  it('is the identity when nothing is before the cut', () => {
    const t = traj([100, 160]);
    expect(trimTrajectory(t, 50)).toBe(t);
    expect(trimTrajectory(t, 100)).toBe(t);
  });

  it('never drops the last sample', () => {
    expect(trimTrajectory(traj([0, 60, 120]), 10_000).times_unix).toEqual([120]);
  });
});
