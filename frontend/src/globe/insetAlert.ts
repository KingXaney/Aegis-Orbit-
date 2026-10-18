// What the satellite inset's border signals at a simulation time: 'maneuver' while a dodge burn fires,
// 'danger' while a critical conjunction is still ahead and not yet dodged, 'normal' otherwise.

/** Simulation seconds the inset keeps showing a burn after its burn time (the burn itself is impulsive). */
export const MANEUVER_HOLD_S = 60;

export interface InsetAlertInput {
  now: number;
  /** Screened conjunctions: `critical` is a CRITICAL threat state. */
  threats: { tcaUnix: number; critical: boolean }[];
  /** Burn times of the approved (committed) maneuvers. */
  burns: number[];
  /** The approved maneuver meets the mitigation target, so the threat is cleared once it has burned. */
  mitigated: boolean;
  /**
   * The main scene's thruster plume (non-null while it fires). Once the scene provides it, it alone
   * decides 'maneuver'; until then (undefined) a burn counts for MANEUVER_HOLD_S after its burn time.
   */
  burnFiring?: { maneuverId: string; intensity: number } | null;
}

export type InsetAlert =
  | { level: 'normal' }
  | { level: 'danger'; tcaUnix: number; burnUnix: number | null }
  | { level: 'maneuver'; burnUnix: number | null };

export function insetAlert({ now, threats, burns, mitigated, burnFiring }: InsetAlertInput): InsetAlert {
  if (burnFiring) return { level: 'maneuver', burnUnix: null };
  if (burnFiring === undefined) {
    const firing = burns.find((b) => now >= b && now < b + MANEUVER_HOLD_S);
    if (firing !== undefined) return { level: 'maneuver', burnUnix: firing };
  }

  const ahead = threats.filter((t) => t.critical && t.tcaUnix > now).map((t) => t.tcaUnix);
  if (ahead.length === 0) return { level: 'normal' };
  const burned = burns.some((b) => b <= now);
  if (burned && mitigated) return { level: 'normal' };
  const nextBurn = burns.filter((b) => b > now).sort((a, b) => a - b)[0] ?? null;
  return { level: 'danger', tcaUnix: Math.min(...ahead), burnUnix: nextBurn };
}
