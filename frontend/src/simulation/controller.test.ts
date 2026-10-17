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
});
