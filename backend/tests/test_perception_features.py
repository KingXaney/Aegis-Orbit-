from dataclasses import replace

import numpy as np
import pytest

from app.perception.features import FEATURE_NAMES, elements_of, pair_features, plane_normal, radius_along, perigee_direction
from app.physics.constants import R_EARTH_KM
from app.physics.frames import circular_state
from app.scenarios import synthetic
from tests.conftest import ISS_TLE

IDX = {n: i for i, n in enumerate(FEATURE_NAMES)}


def _numerical(object_id, a_km, inc, raan, arglat, category="PAYLOAD", e=0.0, argp=0.0):
    from app.scenarios.synthetic import _numerical_object
    if e == 0.0:
        r, v = circular_state(a_km, inc, raan, arglat)
    else:
        # perigee at argument of latitude = argp, object at true anomaly 0 (perigee)
        from app.physics.constants import MU_EARTH_KM3_S2
        p = a_km * (1 - e * e)
        rp = p / (1 + e)
        r, v = circular_state(rp, inc, raan, argp)
        v = v / np.linalg.norm(v) * np.sqrt(MU_EARTH_KM3_S2 * (2.0 / rp - 1.0 / a_km))
    return _numerical_object(object_id, object_id, category, r, v, synthetic.T0_UNIX, 1.0, None, "SYNTHETIC_STATE")


def test_plane_normal_matches_angular_momentum():
    r, v = circular_state(7000.0, 51.6, 40.0, 15.0)
    h = np.cross(r, v)
    assert np.allclose(plane_normal(np.radians(51.6), np.radians(40.0)), h / np.linalg.norm(h), atol=1e-12)
    p = perigee_direction(np.radians(51.6), np.radians(40.0), np.radians(15.0))
    assert np.allclose(p, r / np.linalg.norm(r), atol=1e-12)


def test_identical_and_offset_circular_orbits():
    primary = _numerical("P", R_EARTH_KM + 420.0, 51.6, 40.0, 15.0)
    twin = _numerical("TWIN", R_EARTH_KM + 420.0, 51.6, 40.0, 100.0)
    higher = _numerical("HIGH", R_EARTH_KM + 520.0, 97.0, 120.0, 0.0, category="DEBRIS")
    fm = pair_features(primary, [twin, higher], synthetic.T0_UNIX)
    x_twin, x_high = fm.X[0], fm.X[1]
    assert x_twin[IDX["plane_angle_deg"]] < 0.01 and x_twin[IDX["coplanar_flag"]] == 1.0
    assert abs(x_twin[IDX["dr_node_min_abs_km"]]) < 1e-6 and abs(x_twin[IDX["du_deg"]] - 85.0) < 0.5
    assert abs(x_high[IDX["dr_node_1_km"]] - 100.0) < 1e-6 and abs(x_high[IDX["dr_node_2_km"]] - 100.0) < 1e-6
    assert x_high[IDX["coplanar_flag"]] == 0.0 and x_high[IDX["cat_debris"]] == 1.0 and x_high[IDX["cat_payload"]] == 0.0
    assert abs(x_high[IDX["overlap_depth_km"]] - (-100.0)) < 1e-6


def test_eccentric_orbit_node_radii():
    # secondary perigee on the node line of a primary in a plane 60 deg away
    primary = _numerical("P", 7000.0, 0.0, 0.0, 0.0)
    a_s, e_s = 7200.0, 0.05
    secondary = _numerical("S", a_s, 60.0, 0.0, 0.0, e=e_s, argp=0.0)  # perigee along the x axis = node line
    fm = pair_features(primary, [secondary], synthetic.T0_UNIX)
    x = fm.X[0]
    rp_peri = a_s * (1 - e_s) - 7000.0
    rp_apo = a_s * (1 + e_s) - 7000.0
    assert abs(x[IDX["plane_angle_deg"]] - 60.0) < 1e-6
    assert abs(x[IDX["dr_node_1_km"]] - rp_peri) < 0.5 and abs(x[IDX["dr_node_2_km"]] - rp_apo) < 0.5


def test_synthetic_crossing_angle_and_shapes(synthetic_catalog):
    primary = synthetic_catalog.require(synthetic.PRIMARY_ID)
    fm = pair_features(primary, synthetic_catalog.others(synthetic.PRIMARY_ID), synthetic.T0_UNIX)
    assert fm.X.shape == (len(synthetic.STAGED_PASSES) + 5, len(FEATURE_NAMES)) and fm.ok_mask.all()
    k = fm.object_ids.index(synthetic.SECONDARY_ID)
    assert abs(fm.X[k, IDX["plane_angle_deg"]] - synthetic.CROSSING_ANGLE_DEG) < 2.0
    assert fm.X[k, IDX["dr_node_min_abs_km"]] < 15.0  # the crossing debris passes through the primary's altitude
    assert fm.basis[k] == "OSCULATING_AT_STATE_EPOCH"


def test_missing_elements_give_nan_rows(synthetic_catalog):
    primary = synthetic_catalog.require(synthetic.PRIMARY_ID)
    broken = replace(synthetic_catalog.require(synthetic.SECONDARY_ID), object_id="BROKEN", r0_teme_km=None, v0_teme_kms=None)
    fm = pair_features(primary, [broken, synthetic_catalog.require("SYN-SAT-A")], synthetic.T0_UNIX)
    assert not fm.ok_mask[0] and np.isnan(fm.X[0]).all() and fm.ok_mask[1]
    assert elements_of(broken) is None


def test_sgp4_elements_and_raan_wrap():
    from app.data.tle import parse_tle_text
    iss = parse_tle_text("\n".join(ISS_TLE))[0][0]
    el = elements_of(iss)
    assert el.basis == "SGP4_MEAN" and 6770 < el.a_km < 6810 and abs(np.degrees(el.inc_rad) - 51.6327) < 1e-3
    a = _numerical("A", 7000.0, 50.0, 359.0, 0.0)
    b = _numerical("B", 7000.0, 50.0, 1.0, 0.0)
    fm = pair_features(a, [b], synthetic.T0_UNIX)
    assert abs(fm.X[0, IDX["draan_deg"]] - 2.0) < 1e-6


def test_radius_along_direction():
    a, e = 7000.0, 0.1
    inc, raan, argp = np.radians(10.0), np.radians(20.0), np.radians(30.0)
    p = perigee_direction(inc, raan, argp)
    q = np.cross(plane_normal(inc, raan), p)
    assert abs(radius_along(a, e, p, q, p) - a * (1 - e)) < 1e-9
    assert abs(radius_along(a, e, p, q, -p) - a * (1 + e)) < 1e-9
