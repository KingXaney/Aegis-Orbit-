import { describe, expect, it, vi } from 'vitest';
import { SimulationController } from './controller';

describe('SimulationController', () => {
  it('advances with speed, clamps to the window and pauses at the end', () => {
    const c = new SimulationController(1000, 2000, { notifyIntervalMs: 0, raf: () => 0, caf: () => undefined });
    c.setSpeed(100);
    c.play();
    c.tick(1);
    expect(c.currentUnix).toBe(1100);
    c.tick(20);
    expect(c.currentUnix).toBe(2000);
    expect(c.snapshot.playing).toBe(false);
  });

  it('seeks, resets and notifies subscribers', () => {
    const c = new SimulationController(0, 100, { notifyIntervalMs: 0, raf: () => 0, caf: () => undefined });
    const fn = vi.fn();
    c.subscribe(fn);
    c.seek(50);
    expect(c.currentUnix).toBe(50);
    c.seek(500);
    expect(c.currentUnix).toBe(100);
    c.reset();
    expect(c.currentUnix).toBe(0);
    expect(fn).toHaveBeenCalled();
  });

  it('does not advance while paused', () => {
    const c = new SimulationController(0, 100, { raf: () => 0, caf: () => undefined });
    c.tick(10);
    expect(c.currentUnix).toBe(0);
  });

  it('runs open-ended past any window and keeps playing', () => {
    const c = new SimulationController(0, 100, { notifyIntervalMs: 0, raf: () => 0, caf: () => undefined });
    c.setWindow(1000, null);
    expect(c.snapshot.openEnded).toBe(true);
    expect(c.snapshot.endUnix).toBe(Number.POSITIVE_INFINITY);
    c.setSpeed(1800);
    c.play();
    c.tick(100);
    expect(c.currentUnix).toBe(1000 + 180_000);
    expect(c.playing).toBe(true);
    c.pause();
    c.play(); // never rewinds
    expect(c.currentUnix).toBe(1000 + 180_000);
    c.seek(500); // never before the start
    expect(c.currentUnix).toBe(1000);
    c.reset();
    expect(c.currentUnix).toBe(1000);
    expect(c.playing).toBe(false);
  });

  it('a bounded window set after an open-ended one clamps again', () => {
    const c = new SimulationController(0, 100, { notifyIntervalMs: 0, raf: () => 0, caf: () => undefined });
    c.setWindow(0, null);
    c.setWindow(0, 50);
    expect(c.snapshot.openEnded).toBe(false);
    c.setSpeed(10);
    c.play();
    c.tick(100);
    expect(c.currentUnix).toBe(50);
    expect(c.playing).toBe(false);
  });
});
