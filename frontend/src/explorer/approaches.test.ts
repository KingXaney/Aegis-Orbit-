import type { ApproachRecord } from '../types/api';
import { countdown, km } from './Approaches';
import { approachKey, selectActiveApproach, useExplorerStore } from './store';

const pass = (norad_id: number, tca_unix: number, miss_distance_km: number): ApproachRecord => ({
  norad_id,
  name: `OBJECT ${norad_id}`,
  type: 'DEBRIS',
  tca: new Date(tca_unix * 1000).toISOString(),
  tca_unix,
  miss_distance_km,
  relative_speed_kms: 12,
  primary_position_teme_km: [6800, 0, 0],
  secondary_position_teme_km: [6801, 0, 0],
});

describe('approach formatting', () => {
  it('counts down in hours and minutes, then minutes and seconds, without breaking spaces', () => {
    expect(countdown(3 * 3600 + 38 * 60 + 12)).toBe('3 h 38 m');
    expect(countdown(16 * 60 + 5)).toBe('16 m 05 s');
    expect(countdown(42.7)).toBe('42 s');
    expect(countdown(-3)).toBe('0 s');
  });

  it('gives two decimals under 10 km and one above', () => {
    expect(km(1.846)).toBe('1.85 km');
    expect(km(21.04)).toBe('21.0 km');
  });
});

describe('active approach', () => {
  const a = pass(63989, 2_000_000_000, 1.85);
  const b = pass(44000, 2_000_001_000, 20.5);

  beforeEach(() => {
    useExplorerStore.setState({
      approaches: {
        status: 'ready',
        error: null,
        data: {
          primary_norad_id: 39574, primary_name: 'GPM-CORE', window_start: '', window_end: '', computed_at: '',
          compute_s: 1, catalog_retrieved_at: null, screened: 2, screening_radius_km: 25, approaches: [a, b], note: '',
        },
      },
      pinnedApproach: null,
      previewApproach: null,
    });
  });

  it('shows the previewed pass until one is pinned, then the pinned one', () => {
    const { setPreviewApproach, togglePinnedApproach } = useExplorerStore.getState();
    expect(selectActiveApproach(useExplorerStore.getState())).toBeNull();
    setPreviewApproach(approachKey(b));
    expect(selectActiveApproach(useExplorerStore.getState())).toBe(b);
    togglePinnedApproach(approachKey(a));
    expect(selectActiveApproach(useExplorerStore.getState())).toBe(a);
    togglePinnedApproach(approachKey(a));
    expect(selectActiveApproach(useExplorerStore.getState())).toBe(b);
  });

  it('ignores a key that is no longer in the list', () => {
    useExplorerStore.getState().togglePinnedApproach('1@1');
    expect(selectActiveApproach(useExplorerStore.getState())).toBeNull();
  });
});
