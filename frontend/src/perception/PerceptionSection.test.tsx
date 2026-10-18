import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionCard, type DecisionCardProps } from './PerceptionSection';
import type { PerceptionObject } from './types';

afterEach(cleanup);

const NOW = 1_792_220_000;

function pass(id: string, name: string, tier: PerceptionObject['tier'], missKm: number, tcaUnix: number): PerceptionObject {
  return {
    object_id: id,
    name,
    category: 'DEBRIS',
    tier,
    rank: 1,
    ml: { score: 0.4, predicted_tier: 'WATCH', basis: 'MODEL_ESTIMATE' },
    physics: { status: 'CONJUNCTION', verified: true, conjunction_id: `CJ-${id}`, linked_conjunction_id: null, tca: null, tca_unix: tcaUnix, miss_distance_km: missKm, relative_speed_kms: 8.2, threat_state: 'UNVERIFIED', pc: { status: 'UNVERIFIED', value: null } },
  };
}

function props(over: Partial<DecisionCardProps>): DecisionCardProps {
  return {
    verdict: { kind: 'stay', closest: null, criticalKm: 5 },
    nowUnix: NOW,
    decision: null,
    drillIds: [],
    canDrill: true,
    drillLoading: false,
    planLoading: false,
    onDecide: vi.fn(),
    onDrill: vi.fn(),
    ...over,
  };
}

describe('DecisionCard', () => {
  it('recommends staying on course, names the closest pass and offers a drill', () => {
    const p = props({ verdict: { kind: 'stay', closest: pass('NORAD-1', 'SUPERVIEW-1 03', 'SEMI_CRITICAL', 6.71, NOW + 3600), criticalKm: 5 } });
    render(<DecisionCard {...p} />);
    expect(screen.getByText('Recommendation: stay on course')).toBeTruthy();
    expect(screen.getByText(/SUPERVIEW-1 03 passes 6\.71 km/)).toBeTruthy();
    expect(screen.getByText(/UNVERIFIED: public elements carry no covariance/)).toBeTruthy();
    fireEvent.click(screen.getByText('Acknowledge: stay on course'));
    expect(p.onDecide).toHaveBeenCalledWith('stay');
    fireEvent.click(screen.getByText('Run drill'));
    expect(p.onDrill).toHaveBeenCalled();
  });

  it('hides the drill button once a drill exists and records the stay decision', () => {
    render(<DecisionCard {...props({ canDrill: false, decision: { kind: 'stay', atUnix: NOW } })} />);
    expect(screen.queryByText('Run drill')).toBeNull();
    expect(screen.getByText('Staying on course')).toBeTruthy();
    expect(screen.getByText(/Decision recorded at/)).toBeTruthy();
  });

  it('alerts on a critical drill pass and lets the operator plan a maneuver or stay', () => {
    const drill = pass('DRILL-1', 'DRILL-1 (injected test threat)', 'CRITICAL', 0.354, NOW + 7800);
    const p = props({ verdict: { kind: 'alert', threats: [drill], criticalKm: 5 }, drillIds: ['DRILL-1'] });
    render(<DecisionCard {...p} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Drill')).toBeTruthy();
    expect(screen.getByText(/injected test threat, not a catalogued object/)).toBeTruthy();
    expect(screen.getByText(/passes 354 m from the station at \d\d:\d\d:\d\d UTC \(T−02:10:00\)/)).toBeTruthy();
    fireEvent.click(screen.getByText('Plan avoidance maneuver'));
    expect(p.onDecide).toHaveBeenCalledWith('maneuver');
    fireEvent.click(screen.getByText('Stay on course'));
    expect(p.onDecide).toHaveBeenCalledWith('stay');
  });
});
