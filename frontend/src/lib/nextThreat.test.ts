import { describe, expect, it } from 'vitest';
import { nextThreat } from './nextThreat';
import type { Conjunction } from '../types/api';

function conj(id: string, tca: number, state: Conjunction['threat_state']): Conjunction {
  return { conjunction_id: id, tca_unix: tca, threat_state: state } as Conjunction;
}

describe('nextThreat', () => {
  const list = [conj('small-miss-later', 5000, 'CRITICAL'), conj('first', 3000, 'CRITICAL'), conj('elevated-early', 2000, 'ELEVATED'), conj('monitor', 1000, 'MONITORING')];

  it('prefers the earliest critical pass still ahead', () => {
    expect(nextThreat(list, [], 0)).toBe('first');
  });

  it('skips passes before the clock or before the last committed burn', () => {
    expect(nextThreat(list, [3500], 0)).toBe('small-miss-later');
    expect(nextThreat(list, [], 4000)).toBe('small-miss-later');
  });

  it('falls back to elevated passes, then to the top-ranked conjunction', () => {
    expect(nextThreat([conj('e', 2000, 'ELEVATED'), conj('m', 500, 'MONITORING')], [], 0)).toBe('e');
    expect(nextThreat(list, [6000], 0)).toBe('small-miss-later');
    expect(nextThreat([], [], 0)).toBeNull();
  });
});
