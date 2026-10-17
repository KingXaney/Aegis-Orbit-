import numpy as np

from app.data.tle import parse_tle_text
from app.physics.constants import J2, MU_EARTH_KM3_S2, R_EARTH_KM
from app.physics.frames import circular_state, osculating_elements, rtn_basis
from app.physics.propagation import propagate, propagate_batch, propagate_states
from tests.conftest import ISS_TLE


def _iss():
    return parse_tle_text("\n".join(ISS_TLE))[0][0]


def test_sgp4_output_shape_units_and_frame():
    iss = _iss()
    times = iss.epoch_unix + np.arange(0, 3600, 60.0)
    res = propagate(iss, times)
    assert res.status == "OK" and res.frame == "TEME"
    assert res.positions_km.shape == (60, 3) and res.velocities_kms.shape == (60, 3)
    assert res.units["position"] == "km" and res.units["velocity"] == "km/s"
    radii = np.linalg.norm(res.positions_km, axis=1)
    speeds = np.linalg.norm(res.velocities_kms, axis=1)
    assert np.all((radii > 6700) & (radii < 6900))
    assert np.all((speeds > 7.5) & (speeds < 7.8))
    assert res.source_epoch_unix == iss.epoch_unix


def test_two_body_energy_and_period():
    a = R_EARTH_KM + 500.0
    r0, v0 = circular_state(a, 45.0, 10.0, 0.0)
    period = 2 * np.pi * np.sqrt(a ** 3 / MU_EARTH_KM3_S2)
    times = np.array([period / 2, period, 2 * period])
    ys = propagate_states(np.concatenate([r0, v0])[None, :], 0.0, times, step_s=10.0, include_j2=False)
    e0 = np.linalg.norm(v0) ** 2 / 2 - MU_EARTH_KM3_S2 / np.linalg.norm(r0)
    for y in ys[:, 0]:
        e = np.linalg.norm(y[3:]) ** 2 / 2 - MU_EARTH_KM3_S2 / np.linalg.norm(y[:3])
        assert abs(e - e0) / abs(e0) < 1e-9
    assert np.linalg.norm(ys[1, 0, :3] - r0) < 1e-3  # back at the start after one period (metre level)


def test_j2_nodal_regression_matches_secular_rate():
    a = R_EARTH_KM + 420.0
    inc = 51.6
    r0, v0 = circular_state(a, inc, 30.0, 0.0)
    day = 86400.0
    ys = propagate_states(np.concatenate([r0, v0])[None, :], 0.0, np.array([day]), step_s=10.0)
    raan1 = osculating_elements(ys[0, 0, :3], ys[0, 0, 3:])["raan_deg"]
    n = np.sqrt(MU_EARTH_KM3_S2 / a ** 3)
    analytic = -1.5 * n * J2 * (R_EARTH_KM / a) ** 2 * np.cos(np.radians(inc)) * day
    measured = np.radians(((raan1 - 30.0 + 180) % 360) - 180)
    assert abs(measured - analytic) / abs(analytic) < 0.03


def test_backward_integration_round_trip():
    r0, v0 = circular_state(R_EARTH_KM + 420.0, 51.6, 0.0, 0.0)
    y0 = np.concatenate([r0, v0])[None, :]
    fwd = propagate_states(y0, 0.0, np.array([7200.0]), 10.0)
    back = propagate_states(fwd[0], 7200.0, np.array([0.0]), 10.0)
    assert np.linalg.norm(back[0, 0, :3] - r0) < 1e-5


def test_batch_matches_individual(synthetic_catalog):
    objs = synthetic_catalog.values()
    times = objs[0].state_epoch_unix + np.arange(0, 1800, 300.0)
    iss = _iss()
    times_iss = iss.epoch_unix + np.arange(0, 1800, 300.0)
    batch = propagate_batch(objs, times)
    for o in objs:
        single = propagate(o, times)
        assert np.allclose(batch[o.object_id].positions_km, single.positions_km)
    b2 = propagate_batch([iss], times_iss)
    assert np.allclose(b2[iss.object_id].positions_km, propagate(iss, times_iss).positions_km)


def test_rtn_basis_is_orthonormal_and_right_handed():
    r0, v0 = circular_state(7000.0, 30.0, 40.0, 50.0)
    M = rtn_basis(r0, v0)
    assert np.allclose(M.T @ M, np.eye(3), atol=1e-12)
    assert np.allclose(np.cross(M[:, 0], M[:, 1]), M[:, 2])
    assert np.dot(M[:, 1], v0) > 0  # T is along the velocity for a circular orbit
