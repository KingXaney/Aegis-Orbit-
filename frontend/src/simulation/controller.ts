/**
 * Simulation clock. Single source of truth for the displayed simulation time.
 * The globe reads `currentUnix` every frame; React panels subscribe at a
 * throttled rate. It never produces orbital states itself; positions come from
 * the precomputed trajectories sampled at this time.
 */
export interface ControllerState {
  startUnix: number;
  endUnix: number;
  currentUnix: number;
  playing: boolean;
  speed: number; // simulation seconds per real second
}

type Listener = (s: ControllerState) => void;

export const SPEED_OPTIONS = [1, 10, 30, 60, 120, 300, 600, 1800];

export class SimulationController {
  private state: ControllerState;
  private listeners = new Set<Listener>();
  private rafId: number | null = null;
  private lastFrame: number | null = null;
  private lastNotify = 0;
  private notifyIntervalMs: number;
  private raf: (cb: (t: number) => void) => number;
  private caf: (id: number) => void;

  constructor(startUnix = 0, endUnix = 1, opts: { notifyIntervalMs?: number; raf?: typeof requestAnimationFrame; caf?: typeof cancelAnimationFrame } = {}) {
    this.state = { startUnix, endUnix, currentUnix: startUnix, playing: false, speed: 60 };
    this.notifyIntervalMs = opts.notifyIntervalMs ?? 100;
    this.raf = opts.raf ?? ((cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(() => cb(performance.now()), 16) as unknown as number));
    this.caf = opts.caf ?? ((id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id)));
  }

  get snapshot(): ControllerState {
    return { ...this.state };
  }

  get currentUnix(): number {
    return this.state.currentUnix;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(force = false): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!force && now - this.lastNotify < this.notifyIntervalMs) return;
    this.lastNotify = now;
    const snap = this.snapshot;
    for (const fn of this.listeners) fn(snap);
  }

  setWindow(startUnix: number, endUnix: number, resetTo?: number): void {
    this.state.startUnix = startUnix;
    this.state.endUnix = endUnix;
    this.state.currentUnix = Math.min(Math.max(resetTo ?? startUnix, startUnix), endUnix);
    this.notify(true);
  }

  /** Advance the clock by a real-time delta (seconds). Exposed for tests. */
  tick(dtRealSeconds: number): void {
    if (!this.state.playing) return;
    const next = this.state.currentUnix + dtRealSeconds * this.state.speed;
    if (next >= this.state.endUnix) {
      this.state.currentUnix = this.state.endUnix;
      this.state.playing = false;
      this.notify(true);
      return;
    }
    this.state.currentUnix = Math.max(next, this.state.startUnix);
    this.notify();
  }

  private loop = (frameTime: number): void => {
    if (this.lastFrame !== null) {
      const dt = Math.min((frameTime - this.lastFrame) / 1000, 0.25);
      this.tick(dt);
    }
    this.lastFrame = frameTime;
    if (this.state.playing) this.rafId = this.raf(this.loop);
    else this.rafId = null;
  };

  play(): void {
    if (this.state.playing) return;
    if (this.state.currentUnix >= this.state.endUnix) this.state.currentUnix = this.state.startUnix;
    this.state.playing = true;
    this.lastFrame = null;
    this.rafId = this.raf(this.loop);
    this.notify(true);
  }

  pause(): void {
    if (!this.state.playing) return;
    this.state.playing = false;
    if (this.rafId !== null) this.caf(this.rafId);
    this.rafId = null;
    this.notify(true);
  }

  toggle(): void {
    if (this.state.playing) this.pause();
    else this.play();
  }

  seek(tUnix: number): void {
    this.state.currentUnix = Math.min(Math.max(tUnix, this.state.startUnix), this.state.endUnix);
    this.notify(true);
  }

  setSpeed(speed: number): void {
    this.state.speed = Math.max(0.1, speed);
    this.notify(true);
  }

  reset(): void {
    this.pause();
    this.state.currentUnix = this.state.startUnix;
    this.notify(true);
  }

  destroy(): void {
    this.pause();
    this.listeners.clear();
  }
}

export const controller = new SimulationController();
