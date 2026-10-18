/**
 * When the sandbox asks the backend to evaluate (screen from now and let the autopilot act), and the
 * slow-motion speeds around a close approach. Pure; the store applies the decisions.
 */
export const EVAL_INTERVAL_SIM_S = 600;
/** Real-time debounce between evaluations: each one screens two orbits and may plan burns. */
export const EVAL_MIN_REAL_MS = 4000;
/** Re-evaluate when the screened horizon comes within this many orbits of the clock. */
export const HORIZON_MARGIN_ORBITS = 1;

export interface EvaluateInput {
  enabled: boolean;
  inFlight: boolean;
  nowUnix: number;
  lastEvaluatedUnix: number | null;
  screeningEndUnix: number | null;
  periodS: number;
  lastEvaluateRealMs: number;
  realNowMs: number;
}

export function shouldEvaluate(i: EvaluateInput): boolean {
  if (!i.enabled || i.inFlight) return false;
  if (i.realNowMs - i.lastEvaluateRealMs < EVAL_MIN_REAL_MS) return false;
  if (i.lastEvaluatedUnix === null) return true;
  if (i.nowUnix - i.lastEvaluatedUnix >= EVAL_INTERVAL_SIM_S) return true;
  if (i.screeningEndUnix !== null && i.screeningEndUnix - i.nowUnix < HORIZON_MARGIN_ORBITS * i.periodS) return true;
  return false;
}

/**
 * Planning takes a few real seconds; at speed x the clock moves 5x simulated seconds meanwhile, so no
 * burn is planned sooner than that (at least a minute).
 */
export function earliestBurnAfterS(speed: number): number {
  return Math.max(60, 5 * speed);
}

// Slow motion around a pass: the clock drops to SLOW_FAR_SPEED within ±SLOW_FAR_S of a closest approach
// and to 1x within ±SLOW_NEAR_S, for passes close enough to be worth watching.
export const SLOW_NEAR_S = 10;
export const SLOW_FAR_S = 60;
export const SLOW_FAR_SPEED = 10;
export const SLOW_MAX_MISS_KM = 10;

/** The speed to run at `dtS` seconds from a closest approach, or null to leave the speed alone. */
export function slowSpeedFor(dtS: number, baseSpeed: number): number | null {
  const a = Math.abs(dtS);
  if (a <= SLOW_NEAR_S) return Math.min(baseSpeed, 1);
  if (a <= SLOW_FAR_S) return Math.min(baseSpeed, SLOW_FAR_SPEED);
  return null;
}
