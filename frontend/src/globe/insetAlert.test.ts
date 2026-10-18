import { describe, expect, it } from 'vitest';
import { MANEUVER_HOLD_S, insetAlert } from './insetAlert';

const TCA = 10_800;
const BURN = 7_000;
const critical = [{ tcaUnix: TCA, critical: true, dodgeBurnUnix: null }];
// after the operator approves the dodge, screening sees the committed path: the pass is no longer
// critical there, and the inset learns of it from the committed burn instead
const dodged = [{ tcaUnix: TCA, critical: true, dodgeBurnUnix: BURN }];

describe('insetAlert', () => {
  it('is normal with nothing screened and no burns', () => {
    expect(insetAlert({ now: 0, threats: [], burns: [] })).toEqual({ level: 'normal' });
  });

  it('ignores passes that are not critical', () => {
    expect(insetAlert({ now: 0, threats: [{ tcaUnix: TCA, critical: false, dodgeBurnUnix: null }], burns: [] })).toEqual({ level: 'normal' });
  });

  it('is danger while a critical pass is still ahead, naming its TCA', () => {
    expect(insetAlert({ now: 100, threats: critical, burns: [] })).toEqual({ level: 'danger', tcaUnix: TCA, burnUnix: null });
  });

  it('stays danger after approval until the dodge burn fires, counting down to it', () => {
    expect(insetAlert({ now: 100, threats: dodged, burns: [BURN] })).toEqual({ level: 'danger', tcaUnix: TCA, burnUnix: BURN });
  });

  it('is maneuver from the burn until the hold runs out, then normal once the pass is dodged', () => {
    expect(insetAlert({ now: BURN, threats: dodged, burns: [BURN] })).toEqual({ level: 'maneuver', burnUnix: BURN });
    expect(insetAlert({ now: BURN + MANEUVER_HOLD_S - 1, threats: dodged, burns: [BURN] }).level).toBe('maneuver');
    expect(insetAlert({ now: BURN + MANEUVER_HOLD_S + 1, threats: dodged, burns: [BURN] })).toEqual({ level: 'normal' });
  });

  it('turns to the next critical pass once one is dodged', () => {
    const threats = [...dodged, { tcaUnix: TCA + 3000, critical: true, dodgeBurnUnix: null }];
    expect(insetAlert({ now: BURN + MANEUVER_HOLD_S + 1, threats, burns: [BURN] })).toEqual({ level: 'danger', tcaUnix: TCA + 3000, burnUnix: null });
  });

  it('is normal once the critical pass is behind the clock', () => {
    expect(insetAlert({ now: TCA + 1, threats: critical, burns: [] })).toEqual({ level: 'normal' });
  });

  it('picks the nearest critical TCA still ahead', () => {
    const threats = [TCA + 5_000, 50, TCA].map((t) => ({ tcaUnix: t, critical: true, dodgeBurnUnix: null }));
    expect(insetAlert({ now: 100, threats, burns: [] })).toEqual({ level: 'danger', tcaUnix: TCA, burnUnix: null });
  });

  it("follows the main scene's plume signal instead of the burn time once that signal exists", () => {
    expect(insetAlert({ now: 100, threats: dodged, burns: [BURN], burnFiring: { maneuverId: 'm1' } })).toEqual({ level: 'maneuver', burnUnix: null });
    expect(insetAlert({ now: BURN + 1, threats: dodged, burns: [BURN], burnFiring: null })).toEqual({ level: 'normal' });
  });
});
