import numpy as np

from app.physics.constants import MU_EARTH_KM3_S2
from app.physics.frames import circular_state, inertial_to_rtn, relative_positions_rtn, relative_state_rtn


def test_same_orbit_companion_has_no_comoving_velocity():
    a = 6798.137
    rp, vp = circular_state(a, 51.6, 20.0, 10.0)
    rs, vs = circular_state(a, 51.6, 20.0, 11.0)  # one degree ahead on the same circular orbit
    rel_r, rel_v = relative_state_rtn(rp, vp, rs, vs)
    d = np.radians(1.0)
    assert np.allclose(rel_r, [a * (np.cos(d) - 1.0), a * np.sin(d), 0.0], atol=1e-9)
    assert np.linalg.norm(rel_v) < 1e-9


def test_radial_offset_gives_hill_drift():
    a = 6798.137
    rp, vp = circular_state(a, 30.0, 0.0, 45.0)
    rs, vs = circular_state(a + 1.0, 30.0, 0.0, 45.0)
    rel_r, rel_v = relative_state_rtn(rp, vp, rs, vs)
    n = np.sqrt(MU_EARTH_KM3_S2 / a ** 3)
    assert np.allclose(rel_r, [1.0, 0.0, 0.0], atol=1e-9)
    assert abs(rel_v[1] - (-1.5 * n * 1.0)) < 1e-6  # Clohessy-Wiltshire along-track drift
    assert abs(rel_v[0]) < 1e-9 and abs(rel_v[2]) < 1e-9


def test_relative_position_matches_single_vector_helper():
    rp, vp = circular_state(7000.0, 60.0, 100.0, 200.0)
    rs, vs = circular_state(7100.0, 65.0, 110.0, 190.0)
    rel_r, _ = relative_state_rtn(rp, vp, rs, vs)
    assert np.allclose(rel_r, inertial_to_rtn(rs - rp, rp, vp))
    batched = relative_positions_rtn(np.stack([rp, rp]), np.stack([vp, vp]), np.stack([rs, rs]))
    assert np.allclose(batched[0], rel_r) and np.allclose(batched[1], rel_r)
