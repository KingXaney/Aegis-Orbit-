import { describe, expect, it } from 'vitest';
import { MANEUVER_HOLD_S, insetAlert } from './insetAlert';

const TCA = 10_800;
const BURN = 7_000;
const critical = [{ tcaUnix: TCA, critical: true }];

describe('insetAlert', () => {
  it('is normal with nothing screened and no burns', () => {
    expect(insetAlert({ now: 0, threats: [], burns: [], mitigated: false })).toEqual({ level: 'normal' });
  });

  it('ignores conjunctions that are not critical', () => {
    expect(insetAlert({ now: 0, threats: [{ tcaUnix: TCA, critical: false }], burns: [], mitigated: false })).toEqual({ level: 'normal' });
  });

  it('is danger while a critical conjunction is still ahead, naming its TCA', () => {
    expect(insetAlert({ now: 100, threats: critical, burns: [], mitigated: false })).toEqual({ level: 'danger', tcaUnix: TCA, burnUnix: null });
  });

  it('names the dodge burn while it is still ahead of the clock', () => {
    expect(insetAlert({ now: 100, threats: critical, burns: [BURN], mitigated: true })).toEqual({ level: 'danger', tcaUnix: TCA, burnUnix: BURN });
  });

  it('is maneuver from the burn until the hold runs out', () => {
    expect(insetAlert({ now: BURN, threats: critical, burns: [BURN], mitigated: true })).toEqual({ level: 'maneuver', burnUnix: BURN });
    expect(insetAlert({ now: BURN + MANEUVER_HOLD_S - 1, threats: critical, burns: [BURN], mitigated: true }).level).toBe('maneuver');
  });

  it('clears after a burn that meets the target, but stays danger after one that does not', () => {
    const after = BURN + MANEUVER_HOLD_S + 1;
    expect(insetAlert({ now: after, threats: critical, burns: [BURN], mitigated: true })).toEqual({ level: 'normal' });
    expect(insetAlert({ now: after, threats: critical, burns: [BURN], mitigated: false })).toEqual({ level: 'danger', tcaUnix: TCA, burnUnix: null });
  });

  it('is normal once the critical pass is behind the clock', () => {
    expect(insetAlert({ now: TCA + 1, threats: critical, burns: [], mitigated: false })).toEqual({ level: 'normal' });
  });

  it('picks the nearest critical TCA still ahead', () => {
    const threats = [{ tcaUnix: TCA + 5_000, critical: true }, { tcaUnix: 50, critical: true }, { tcaUnix: TCA, critical: true }];
    expect(insetAlert({ now: 100, threats, burns: [], mitigated: false })).toEqual({ level: 'danger', tcaUnix: TCA, burnUnix: null });
  });

  it("follows the main scene's plume signal instead of the burn time once that signal exists", () => {
    const firing = { maneuverId: 'm1', intensity: 0.6 };
    expect(insetAlert({ now: 100, threats: critical, burns: [BURN], mitigated: true, burnFiring: firing })).toEqual({ level: 'maneuver', burnUnix: null });
    expect(insetAlert({ now: BURN + 1, threats: critical, burns: [BURN], mitigated: true, burnFiring: null })).toEqual({ level: 'normal' });
  });
});
