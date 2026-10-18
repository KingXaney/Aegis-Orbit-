// What the satellite inset's border signals at a simulation time: 'maneuver' while a dodge burn fires,
// 'danger' while a critical pass is still ahead and its dodge has not fired yet, 'normal' otherwise.

/** Simulation seconds the inset keeps showing a burn after its burn time (the burn itself is impulsive). */
export const MANEUVER_HOLD_S = 60;

export interface InsetThreat {
  tcaUnix: number;
  /** CRITICAL when screened against the original path. */
  critical: boolean;
  /** The committed burn that dodges this pass, if one is approved; the pass is safe once it has fired. */
  dodgeBurnUnix: number | null;
}

export interface InsetAlertInput {
  now: number;
  threats: InsetThreat[];
  /** Burn times of the committed maneuvers. */
  burns: number[];
  /**
   * The main scene's thruster plume (non-null while it fires). Once the scene provides it, it alone
   * decides 'maneuver'; until then (undefined) a burn counts for MANEUVER_HOLD_S after its burn time.
   */
  burnFiring?: { maneuverId: string } | null;
}

export type InsetAlert =
  | { level: 'normal' }
  | { level: 'danger'; tcaUnix: number; burnUnix: number | null }
  | { level: 'maneuver'; burnUnix: number | null };

export function insetAlert({ now, threats, burns, burnFiring }: InsetAlertInput): InsetAlert {
  if (burnFiring) return { level: 'maneuver', burnUnix: null };
  if (burnFiring === undefined) {
    const firing = burns.find((b) => now >= b && now < b + MANEUVER_HOLD_S);
    if (firing !== undefined) return { level: 'maneuver', burnUnix: firing };
  }
  const ahead = threats
    .filter((t) => t.critical && t.tcaUnix > now && !(t.dodgeBurnUnix !== null && t.dodgeBurnUnix <= now))
    .sort((a, b) => a.tcaUnix - b.tcaUnix);
  if (ahead.length === 0) return { level: 'normal' };
  return { level: 'danger', tcaUnix: ahead[0].tcaUnix, burnUnix: ahead[0].dodgeBurnUnix };
}
