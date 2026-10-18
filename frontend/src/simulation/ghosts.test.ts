import { describe, expect, it } from 'vitest';
import {
  GHOST_HOLD_S,
  GHOST_WARN_S,
  aliveGhosts,
  crashPointOf,
  expiredGhostIds,
  formatMiss,
  ghostCrashEvents,
  ghostFetchRange,
  ghostLabel,
  ghostPhase,
  ghostWarning,
  ghostWarningText,
  ghostsFromCommitted,
  type Ghost,
} from './ghosts';
import type { AvoidedPass, CommittedManeuver, ObjectSummary, Trajectory } from '../types/api';

const BURN = 10_000;
const CRASH = 13_000;

function avoided(over: Partial<AvoidedPass> = {}): AvoidedPass {
  return {
    conjunction_id: 'CJ-SYN-GPM-SBX-FRAG-001-13000', secondary_id: 'SBX-FRAG-001', secondary_name: 'Fragment 1', tca: '', tca_unix: CRASH,
    miss_km: 0.35, relative_speed_kms: 7.1, threat_state: 'CRITICAL', ghost_r_km: [7000, 0, 0], secondary_r_km: [7000.3, 0, 0], basis: 'screening', ...over,
  };
}

function burn(id: string, over: Partial<CommittedManeuver> = {}): CommittedManeuver {
  return { maneuver_id: id, burn_time_unix: BURN, burn_time: '', post_miss_distance_km: 6.6, avoided_pass: avoided(), ...over } as CommittedManeuver;
}

const objects: Record<string, ObjectSummary> = { 'SBX-FRAG-001': { object_id: 'SBX-FRAG-001' } as ObjectSummary };

function ready(g: Ghost): Ghost {
  const trajectory = { times_unix: [CRASH - 60, CRASH, CRASH + 60], positions_km: [[6999, 0, 0], [7000, 0, 0], [7001, 0, 0]], velocities_kms: [[0.0167, 0, 0], [0.0167, 0, 0], [0.0167, 0, 0]] } as unknown as Trajectory;
  return { ...g, trajectory, status: 'ready' };
}

describe('ghostsFromCommitted', () => {
  it('makes one ghost per committed burn that has an avoided pass, in burn order', () => {
    const ghosts = ghostsFromCommitted([burn('m1'), burn('m2', { burn_time_unix: BURN + 500, avoided_pass: avoided({ tca_unix: CRASH + 900 }) })], [], 5, objects);
    expect(ghosts.map((g) => [g.id, g.index, g.bornUnix, g.crashUnix])).toEqual([['m1', 1, BURN, CRASH], ['m2', 2, BURN + 500, CRASH + 900]]);
    expect(ghosts[0]).toMatchObject({ secondaryId: 'SBX-FRAG-001', secondaryName: 'Fragment 1', missKm: 0.35, postMissKm: 6.6, criticalRadiusKm: 5, status: 'loading', attempts: 0, trajectory: null });
    expect(ghosts[0].crashPointTeme).toEqual([7000, 0, 0]);
  });

  it('skips burns without an avoided pass or whose object is gone, and keeps fetched ghosts by id', () => {
    const first = ghostsFromCommitted([burn('m1'), burn('m2', { avoided_pass: null }), burn('m3', { avoided_pass: avoided({ secondary_id: 'SBX-RB-009' }) })], [], 5, objects);
    expect(first.map((g) => g.id)).toEqual(['m1']);
    const loaded = [ready(first[0])];
    // a refreshed committed list with the same burns: the very same array comes back
    expect(ghostsFromCommitted([burn('m1')], loaded, 5, objects)).toBe(loaded);
    // a new burn joins; the loaded ghost keeps its trajectory and identity
    const next = ghostsFromCommitted([burn('m1'), burn('m4', { burn_time_unix: BURN + 100 })], loaded, 5, objects);
    expect(next).not.toBe(loaded);
    expect(next[0]).toBe(loaded[0]);
    expect(next[1]).toMatchObject({ id: 'm4', index: 2, status: 'loading' });
    // the burn is withdrawn: its ghost goes
    expect(ghostsFromCommitted([burn('m4', { burn_time_unix: BURN + 100 })], next, 5, objects).map((g) => g.id)).toEqual(['m4']);
    // without an object map the object check is skipped
    expect(ghostsFromCommitted([burn('m3', { avoided_pass: avoided({ secondary_id: 'SBX-RB-009' }) })], [], 5).map((g) => g.id)).toEqual(['m3']);
  });
});

describe('ghost lifetime', () => {
  const g = ghostsFromCommitted([burn('m1')], [], 5)[0];

  it('has a phase for every time', () => {
    expect(ghostPhase(g, BURN - 1)).toBe('pending');
    expect(ghostPhase(g, BURN)).toBe('alive');
    expect(ghostPhase(g, CRASH - 1)).toBe('alive');
    expect(ghostPhase(g, CRASH)).toBe('crashing');
    expect(ghostPhase(g, CRASH + GHOST_HOLD_S - 0.01)).toBe('crashing');
    expect(ghostPhase(g, CRASH + GHOST_HOLD_S)).toBe('gone');
  });

  it('fetches a little beyond both ends of its life', () => {
    expect(ghostFetchRange(g)).toEqual({ startUnix: BURN - 120, endUnix: CRASH + 120 });
  });

  it('lists alive ghosts soonest crash first and crash events only while born and not gone', () => {
    const later = { ...g, id: 'm2', crashUnix: CRASH + 500 };
    expect(aliveGhosts([later, g], BURN + 10).map((x) => x.id)).toEqual(['m1', 'm2']);
    expect(aliveGhosts([later, g], BURN - 10)).toEqual([]);
    expect(aliveGhosts([later, g], CRASH + 2).map((x) => x.id)).toEqual(['m1', 'm2']); // crashing still counts
    expect(ghostCrashEvents([g], BURN - 1)).toEqual([]);
    expect(ghostCrashEvents([g], CRASH - 30)).toMatchObject([{ id: 'ghost:m1', atUnix: CRASH, missKm: 0.35 }]);
    expect(ghostCrashEvents([g], CRASH + GHOST_HOLD_S - 1)).toHaveLength(1);
    expect(ghostCrashEvents([g], CRASH + GHOST_HOLD_S)).toEqual([]);
    expect(ghostCrashEvents([g], CRASH - 30)[0].label).toContain('Fragment 1');
  });

  it('expires only on an open-ended clock', () => {
    expect(expiredGhostIds([g], CRASH + GHOST_HOLD_S + 1, true)).toEqual(['m1']);
    expect(expiredGhostIds([g], CRASH + GHOST_HOLD_S + 1, false)).toEqual([]);
    expect(expiredGhostIds([g], CRASH - 1, true)).toEqual([]);
  });

  it('warns for the soonest ghost inside the window and reports the crash during the hold', () => {
    const later = { ...g, id: 'm2', crashUnix: CRASH + 40 };
    expect(ghostWarning([later, g], CRASH - GHOST_WARN_S - 1)).toBeNull();
    expect(ghostWarning([later, g], CRASH - 42)).toMatchObject({ ghost: { id: 'm1' }, dt: 42, phase: 'warning' });
    expect(ghostWarning([later, g], CRASH + 2)).toMatchObject({ ghost: { id: 'm1' }, phase: 'crashed' });
    expect(ghostWarning([later, g], CRASH + GHOST_HOLD_S + 1)).toMatchObject({ ghost: { id: 'm2' }, phase: 'warning' });
    expect(ghostWarning([g], BURN - 5)).toBeNull(); // not born yet
  });

  it('writes the warning with the true miss distance', () => {
    expect(formatMiss(0.35)).toBe('350 m');
    expect(formatMiss(6.64)).toBe('6.6 km');
    expect(ghostWarningText(g, 42)).toBe('Without the dodge: ghost meets Fragment 1 in 00:42 (350 m, inside the 5 km safety radius)');
    expect(ghostWarningText(g, -2)).toContain('would have passed 350 m from Fragment 1');
    expect(ghostLabel(g)).toBe('Ghost 1 · no burn 02:46:40');
  });

  it('knows where the crash is: the screened point first, else a sample of its own path', () => {
    expect(crashPointOf(g)).toEqual([7000, 0, 0]);
    const unscreened = { ...g, crashPointTeme: null };
    expect(crashPointOf(unscreened)).toBeNull();
    expect(crashPointOf(ready(unscreened))).toEqual([7000, 0, 0]);
  });
});
