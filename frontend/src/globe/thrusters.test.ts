import { describe, expect, it } from 'vitest';
import { FIRE_MS, INITIAL_PLUME, LATE_FIRE_FACTOR, NOZZLE_FACES, PRE_GLOW_INTENSITY, advancePlume, coreHalfExtents, describeFace, dvBodyDirection, firingFace, plumeIntensity, plumeSpec, rcsNozzles } from './thrusters';
import type { SpacecraftDesign } from '../types/api';

const GPM: SpacecraftDesign = { design_id: 'gpm', label: 'GPM', length_m: 6.5, width_m: 13, height_m: 5, basis: 'PUBLISHED_SPEC', reference: '' };

describe('directions', () => {
  it('maps RTN delta-v into the body frame (T, N, R)', () => {
    expect(dvBodyDirection([0, 1, 0])).toEqual([1, 0, 0]);
    expect(dvBodyDirection([0, 0, 2])).toEqual([0, 1, 0]);
    expect(dvBodyDirection([-3, 0, 0])).toEqual([0, 0, -1]);
  });

  it('fires the nozzle opposite to the velocity change', () => {
    expect(firingFace([0, 0.35, 0])).toBe('-x'); // +T burn: exhaust aft
    expect(firingFace([0, -0.35, 0])).toBe('+x');
    expect(firingFace([0.2, 0, 0])).toBe('-z'); // +R burn: exhaust toward the Earth
    expect(firingFace([-0.2, 0, 0])).toBe('+z');
    expect(firingFace([0, 0, 0.1])).toBe('-y');
    expect(firingFace([0, 0.1, -0.3])).toBe('+y'); // the dominant component decides
  });
});

describe('geometry', () => {
  it('keeps cross-track nozzles on the bus, not the array tips', () => {
    expect(coreHalfExtents(GPM)).toEqual([3.25, 3.25, 2.5]);
    const nozzles = rcsNozzles(GPM);
    expect(nozzles).toHaveLength(6);
    const plusY = nozzles.find((n) => n.face === '+y')!;
    expect(plusY.center[1]).toBeCloseTo(3.25 + plusY.length / 2);
    expect(plusY.dir).toEqual([0, 1, 0]);
    for (const n of nozzles) {
      expect(n.length).toBeCloseTo(0.4);
      expect(n.exitRadius).toBeCloseTo(0.2);
      // every nozzle sits just outside its core face
      const axis = n.dir.findIndex((c) => c !== 0);
      expect(Math.abs(n.center[axis])).toBeGreaterThan(coreHalfExtents(GPM)[axis]);
    }
  });

  it('builds a plume cone from the nozzle exit outward', () => {
    const p = plumeSpec(GPM, '-x');
    expect(p.dir).toEqual([-1, 0, 0]);
    expect(p.length).toBeCloseTo(2.5 * 13);
    expect(p.baseRadius).toBeCloseTo(0.12 * 13);
    expect(p.center[0]).toBeCloseTo(-(3.25 + 0.4) - p.length / 2);
  });

  it('describes every nozzle', () => {
    for (const face of NOZZLE_FACES) {
      const d = describeFace(face);
      expect(d.nozzle.length).toBeGreaterThan(3);
      expect(d.effect.length).toBeGreaterThan(3);
    }
    expect(describeFace(firingFace([0, -0.3, 0])).effect).toContain('−T');
  });
});

describe('plume state machine', () => {
  const burn = { id: 'MV-1', burnUnix: 1000, dvRtn: [0, 0.35, 0] };
  const input = (nowUnix: number, realNowMs: number, extra: Partial<Parameters<typeof advancePlume>[1]> = {}) => ({ nowUnix, speed: 60, playing: true, realNowMs, burns: [burn], ...extra });

  it('fires once on a forward crossing and fades over FIRE_MS', () => {
    let s = advancePlume(INITIAL_PLUME, input(900, 0));
    expect(s.active).toBeNull();
    s = advancePlume(s, input(1010, 100));
    expect(s.active).toEqual({ id: 'MV-1', face: '-x', startedMs: 100 });
    expect(plumeIntensity(s, 100)).toBe(1);
    expect(plumeIntensity(s, 100 + FIRE_MS / 2)).toBeCloseTo(0.375);
    s = advancePlume(s, input(1100, 100 + FIRE_MS));
    expect(s.active).toBeNull();
    expect(plumeIntensity(s, 2000)).toBe(0);
    s = advancePlume(s, input(1200, 3000));
    expect(s.active).toBeNull(); // never twice
  });

  it('never fires for burns already past on the first frame or after a jump backwards', () => {
    const first = advancePlume(INITIAL_PLUME, input(1500, 0));
    expect(first.active).toBeNull();
    expect(first.firedIds).toEqual(['MV-1']);
    let s = advancePlume(INITIAL_PLUME, input(1500, 0));
    expect(s.firedIds).toEqual(['MV-1']);
    s = advancePlume(s, input(100, 50)); // reset jump: nothing fires on this frame
    expect(s.active).toBeNull();
    s = advancePlume(s, input(1100, 100)); // and the clock crossing the burn again afterwards is a real crossing
    expect(s.active?.id).toBe('MV-1');
  });

  it('fires late for a burn that arrives just after its time, within the latency window', () => {
    let s = advancePlume(INITIAL_PLUME, input(1050, 0, { burns: [] }));
    s = advancePlume(s, input(1100, 100)); // the burn list arrives 100 s after the burn at 60x (< 300 s)
    expect(s.active?.id).toBe('MV-1');
    let t = advancePlume(INITIAL_PLUME, input(1200, 0, { burns: [] }));
    t = advancePlume(t, input(1000 + LATE_FIRE_FACTOR * 60 + 1, 100));
    expect(t.active).toBeNull();
    // a burn that lands between two frames while its record arrives counts as a crossing
    let u = advancePlume(INITIAL_PLUME, input(900, 0, { burns: [] }));
    u = advancePlume(u, input(1400, 100));
    expect(u.active?.id).toBe('MV-1');
  });

  it('fires the latest of several burns crossed in one frame', () => {
    const burns = [burn, { id: 'MV-2', burnUnix: 1500, dvRtn: [0, -0.2, 0] }];
    let s = advancePlume(INITIAL_PLUME, input(900, 0, { burns }));
    s = advancePlume(s, input(1600, 100, { burns }));
    expect(s.active?.id).toBe('MV-2');
    expect(s.active?.face).toBe('+x');
    expect(s.firedIds).toEqual(['MV-1', 'MV-2']);
  });

  it('pre-glows the nozzle shortly before a burn while playing', () => {
    const s = advancePlume(INITIAL_PLUME, input(1000 - 30, 0)); // 30 sim-s = 0.5 real-s at 60x
    expect(s.preGlow).toEqual({ id: 'MV-1', face: '-x' });
    expect(plumeIntensity(s, 0)).toBe(PRE_GLOW_INTENSITY);
    expect(advancePlume(INITIAL_PLUME, input(1000 - 30, 0, { playing: false })).preGlow).toBeNull();
    expect(advancePlume(INITIAL_PLUME, input(1000 - 300, 0)).preGlow).toBeNull();
  });

  it('forgets burns that leave the list so a re-committed one can fire again', () => {
    let s = advancePlume(INITIAL_PLUME, input(1500, 0));
    s = advancePlume(s, input(1600, 100, { burns: [] }));
    expect(s.firedIds).toEqual([]);
  });
});
