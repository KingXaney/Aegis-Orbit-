from dataclasses import replace

import numpy as np

from app.physics.frames import circular_state
from app.physics.screening import (Conjunction, altitude_overlap_filter, dedupe, find_local_minima, screen)
from app.scenarios import synthetic


def test_synthetic_conjunction_is_detected_and_refined(synthetic_screening):
    conj = synthetic_screening.conjunctions[0]
    assert conj.secondary_id == synthetic.SECONDARY_ID
    designed_tca = synthetic.T0_UNIX + synthetic.TCA_OFFSET_S
    assert abs(conj.tca_unix - designed_tca) < 0.05
    designed_miss = float(np.hypot(synthetic.MISS_HORIZONTAL_KM, synthetic.MISS_RADIAL_KM))
    assert abs(conj.miss_distance_km - designed_miss) < 2e-3
    assert 7.0 < conj.relative_speed_kms < 8.5
    assert conj.refinement["converged"] and conj.refinement["function_evaluations"] > 3
    assert conj.rank == 1 and synthetic_screening.stats["complete"]


def test_refinement_improves_on_coarse_sample(synthetic_catalog, synthetic_window):
    primary = synthetic_catalog.require(synthetic.PRIMARY_ID)
    # a 37 s grid does not contain the designed TCA, so the coarse minimum must be worse than the refined one
    res = screen(primary, [synthetic_catalog.require(synthetic.SECONDARY_ID)], synthetic_window["start_unix"],
                 synthetic_window["end_unix"], coarse_step_s=37.0)
    conj = res.conjunctions[0]
    assert conj.coarse_min_distance_km > conj.miss_distance_km + 1.0
    assert abs(conj.miss_distance_km - 0.3535) < 2e-3


def test_background_objects_do_not_threaten(synthetic_screening):
    secondaries = {c.secondary_id for c in synthetic_screening.conjunctions}
    assert secondaries == {synthetic.SECONDARY_ID}


def test_local_minima_detection():
    d = np.array([5.0, 3.0, 1.0, 2.0, 4.0, 2.5, 2.5, 3.0, np.nan, 1.0, 2.0])
    assert find_local_minima(d) == [2, 5]


def test_altitude_filter_keeps_crossing_eccentric_orbits(synthetic_catalog):
    primary = synthetic_catalog.require(synthetic.PRIMARY_ID)
    high = replace(primary, object_id="HIGH", perigee_alt_km=800.0, apogee_alt_km=820.0)
    eccentric = replace(primary, object_id="ECC", perigee_alt_km=300.0, apogee_alt_km=1500.0)
    unknown = replace(primary, object_id="UNK", perigee_alt_km=None, apogee_alt_km=None)
    kept = {o.object_id for o in altitude_overlap_filter(primary, [high, eccentric, unknown], margin_km=50.0)}
    assert kept == {"ECC", "UNK"}


def test_identical_elements_are_classified_co_orbital(synthetic_catalog, synthetic_window):
    primary = synthetic_catalog.require(synthetic.PRIMARY_ID)
    twin = replace(primary, object_id="TWIN", name="docked twin")
    res = screen(primary, [twin], synthetic_window["start_unix"], synthetic_window["start_unix"] + 3600)
    assert not res.conjunctions
    assert len(res.co_orbital) == 1 and res.co_orbital[0]["object_id"] == "TWIN"


def test_dedupe_merges_adjacent_detections():
    def mk(tca, miss):
        z = np.zeros(3)
        return Conjunction("id", "P", "S", tca, miss, 7.0, z, z, z, z, z, z, None, None, "M", "M", 30.0, miss, {})
    merged = dedupe([mk(1000.0, 2.0), mk(1030.0, 1.0), mk(5000.0, 3.0)], coarse_step_s=30.0)
    assert [c.tca_unix for c in merged] == [1030.0, 5000.0]
