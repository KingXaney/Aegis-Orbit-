import type { Conjunction } from '../types/api';

/**
 * The conjunction an operator (or the autopilot) should look at next: the earliest CRITICAL pass, then
 * the earliest ELEVATED one, whose closest approach is still ahead of both the clock and the last
 * committed burn (burns are append-only in time, so earlier passes can no longer be dodged). With
 * nothing left to handle, the screening's top-ranked conjunction.
 */
export function nextThreat(conjunctions: Conjunction[], committedBurnTimesUnix: number[], nowUnix: number): string | null {
  const floor = Math.max(nowUnix, ...committedBurnTimesUnix);
  const ahead = conjunctions.filter((c) => c.tca_unix > floor);
  for (const state of ['CRITICAL', 'ELEVATED'] as const) {
    const pick = ahead.filter((c) => c.threat_state === state).sort((a, b) => a.tca_unix - b.tca_unix)[0];
    if (pick) return pick.conjunction_id;
  }
  return conjunctions[0]?.conjunction_id ?? null;
}
