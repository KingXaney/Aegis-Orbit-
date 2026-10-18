import { describe, expect, it } from 'vitest';
import { EVAL_INTERVAL_SIM_S, EVAL_MIN_REAL_MS, earliestBurnAfterS, shouldEvaluate, slowSpeedFor } from './schedule';

const base = { enabled: true, inFlight: false, nowUnix: 10_000, lastEvaluatedUnix: 9_900, screeningEndUnix: 10_000 + 11_000, periodS: 5600, lastEvaluateRealMs: 0, realNowMs: 100_000 };

describe('shouldEvaluate', () => {
  it('never evaluates when disabled, in flight or inside the real-time debounce', () => {
    expect(shouldEvaluate({ ...base, enabled: false, lastEvaluatedUnix: null })).toBe(false);
    expect(shouldEvaluate({ ...base, inFlight: true, lastEvaluatedUnix: null })).toBe(false);
    expect(shouldEvaluate({ ...base, lastEvaluatedUnix: null, lastEvaluateRealMs: 100_000 - EVAL_MIN_REAL_MS + 1 })).toBe(false);
  });

  it('evaluates the first time, every interval of simulated time, and when the horizon runs short', () => {
    expect(shouldEvaluate({ ...base, lastEvaluatedUnix: null })).toBe(true);
    expect(shouldEvaluate(base)).toBe(false);
    expect(shouldEvaluate({ ...base, nowUnix: 9_900 + EVAL_INTERVAL_SIM_S })).toBe(true);
    expect(shouldEvaluate({ ...base, screeningEndUnix: 10_000 + 5_000 })).toBe(true);
    expect(shouldEvaluate({ ...base, screeningEndUnix: null })).toBe(false);
  });
});

describe('earliestBurnAfterS', () => {
  it('scales the planning margin with the clock speed, never under a minute', () => {
    expect(earliestBurnAfterS(1)).toBe(60);
    expect(earliestBurnAfterS(60)).toBe(300);
    expect(earliestBurnAfterS(600)).toBe(3000);
  });
});

describe('slowSpeedFor', () => {
  it('slows in two tiers around a pass and leaves the speed alone elsewhere', () => {
    expect(slowSpeedFor(0, 60)).toBe(1);
    expect(slowSpeedFor(-9, 60)).toBe(1);
    expect(slowSpeedFor(30, 60)).toBe(10);
    expect(slowSpeedFor(-59, 600)).toBe(10);
    expect(slowSpeedFor(61, 60)).toBeNull();
    expect(slowSpeedFor(30, 1)).toBe(1); // never faster than the user's own speed
  });
});
