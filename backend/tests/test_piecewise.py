"""Piecewise (committed-burn) propagation, anchoring, batching and catalog mutation rules."""
from dataclasses import replace

import numpy as np
import pytest

from app.data.catalog import Catalog
from app.physics.frames import rtn_basis
from app.physics.maneuver_planner import burn_segment, with_segment, without_last_burn
from app.physics.propagation import (MODEL_NUMERICAL, MODEL_PIECEWISE, anchored, anchored_with_state, burn_times,
                                     latest_state, original_of, propagate, propagate_batch, propagate_states, state_at)
from app.scenarios import synthetic

T0 = synthetic.T0_UNIX


@pytest.fixture()
def primary(synthetic_catalog):
    return synthetic_catalog.require(synthetic.PRIMARY_ID)


@pytest.fixture()
def one_burn(primary):
    seg = burn_segment(primary, T0 + 3000.0, [0.0, 0.5, 0.0], "MV-TEST-001", "+T")
    return with_segment(primary, seg)


@pytest.fixture()
def two_burns(one_burn):
    seg2 = burn_segment(one_burn, T0 + 6000.0, [-0.3, 0.0, 0.0], "MV-TEST-002", "-R")
    return with_segment(one_burn, seg2)


def test_burn_segment_applies_dv_in_rtn(primary):
    seg = burn_segment(primary, T0 + 3000.0, [0.0, 0.5, 0.0], "MV-TEST-001", "+T")
    r_b, v_b = state_at(primary, T0 + 3000.0)
    assert np.allclose(seg.r0_km, r_b)
    dv_teme_kms = rtn_basis(r_b, v_b) @ np.array([0.0, 0.5, 0.0]) / 1000.0
    assert np.allclose(seg.v0_kms - v_b, dv_teme_kms)
    assert seg.t_start_unix == seg.epoch_unix == T0 + 3000.0
    assert seg.dv_mps == pytest.approx(0.5) and seg.direction == "+T"


def test_position_is_continuous_and_velocity_jumps_at_the_burn(primary, one_burn):
    tb = T0 + 3000.0
    assert one_burn.propagation_model == MODEL_PIECEWISE
    assert one_burn.base_model == MODEL_NUMERICAL
    assert burn_times(one_burn) == [tb]
    res = propagate(one_burn, np.array([tb - 1e-3, tb, tb + 1e-3]))
    assert res.status == "OK" and res.model == MODEL_PIECEWISE
    # position is continuous: across each millisecond it moves by velocity x dt and nothing else
    assert np.linalg.norm(res.positions_km[1] - res.positions_km[0] - res.velocities_kms[0] * 1e-3) < 1e-6
    assert np.linalg.norm(res.positions_km[2] - res.positions_km[1] - res.velocities_kms[1] * 1e-3) < 1e-6
    r_b, v_b = state_at(primary, tb)
    dv_teme_kms = rtn_basis(r_b, v_b) @ np.array([0.0, 0.5, 0.0]) / 1000.0
    assert np.allclose(res.velocities_kms[1] - res.velocities_kms[0], dv_teme_kms, atol=2e-5)  # gravity adds ~9e-6 per ms
    # before the burn the committed object is the original
    before = propagate(one_burn, np.array([T0 + 1000.0]))
    assert np.allclose(before.positions_km[0], propagate(primary, np.array([T0 + 1000.0])).positions_km[0])


def test_two_burns_dispatch_per_arc(primary, one_burn, two_burns):
    tb1, tb2 = T0 + 3000.0, T0 + 6000.0
    times = T0 + np.arange(0.0, 9000.0, 250.0)
    res = propagate(two_burns, times)
    base = propagate(primary, times[times < tb1])
    s1, s2 = two_burns.segments
    arc1 = propagate_states(np.concatenate([s1.r0_km, s1.v0_kms])[None, :], s1.epoch_unix, times[(times >= tb1) & (times < tb2)])
    arc2 = propagate_states(np.concatenate([s2.r0_km, s2.v0_kms])[None, :], s2.epoch_unix, times[times >= tb2])
    expected = np.concatenate([base.positions_km, arc1[:, 0, :3], arc2[:, 0, :3]])
    assert np.allclose(res.positions_km, expected, atol=1e-9)
    assert burn_times(two_burns) == [tb1, tb2]
    assert latest_state(two_burns)[0] == tb2


def test_burns_must_be_appended_in_time_order(primary, one_burn):
    with pytest.raises(ValueError):
        with_segment(one_burn, burn_segment(primary, T0 + 2900.0, [0.0, 0.1, 0.0], "MV-TEST-X", "+T"))


def test_anchoring_keeps_later_arcs_and_the_same_path(two_burns):
    tb1, tb2 = T0 + 3000.0, T0 + 6000.0
    times = T0 + np.arange(0.0, 9000.0, 300.0)
    ref = propagate(two_burns, times).positions_km
    mid = anchored(two_burns, tb1 + 500.0)
    assert len(mid.segments) == 2
    assert mid.segments[0].epoch_unix == tb1 + 500.0 and mid.segments[0].t_start_unix == tb1
    assert mid.segments[1] == two_burns.segments[1]
    assert np.abs(propagate(mid, times).positions_km - ref).max() < 1e-3
    early = anchored(two_burns, T0 + 100.0)
    assert early.state_epoch_unix == T0 + 100.0 and early.segments == two_burns.segments
    assert np.abs(propagate(early, times).positions_km - ref).max() < 1e-3
    r, v = state_at(two_burns, tb1 + 500.0)
    direct = anchored_with_state(two_burns, tb1 + 500.0, r, v)
    assert np.allclose(propagate(direct, times).positions_km, propagate(mid, times).positions_km, atol=1e-9)


def test_batch_groups_epochs_and_handles_piecewise(synthetic_catalog, two_burns):
    objs = synthetic_catalog.values()
    moved = anchored(objs[-1], T0 + 600.0)  # a numerical object on another integration epoch
    committed = replace(two_burns, object_id="SYN-GPM-COMMITTED")
    everything = objs[:-1] + [moved, committed]
    times = T0 + np.arange(0.0, 7200.0, 400.0)
    batch = propagate_batch(everything, times)
    assert set(batch) == {o.object_id for o in everything}
    for o in everything:
        single = propagate(o, times)
        assert np.allclose(batch[o.object_id].positions_km, single.positions_km, atol=1e-9)
        assert batch[o.object_id].model == single.model


def test_with_segment_refreshes_the_orbit_summary(primary):
    boosted = with_segment(primary, burn_segment(primary, T0 + 3000.0, [0.0, 5.0, 0.0], "MV-TEST-BIG", "+T"))
    assert boosted.period_s > primary.period_s
    assert boosted.apogee_alt_km > primary.apogee_alt_km + 5.0
    assert "POST_BURN_NUMERICAL" in boosted.position_basis and "MV-TEST-BIG" in boosted.position_basis
    assert boosted.base_position_basis == primary.position_basis


def test_without_last_burn_and_original(primary, one_burn, two_burns):
    times = T0 + np.arange(0.0, 9000.0, 500.0)
    back_one = without_last_burn(two_burns)
    assert len(back_one.segments) == 1
    assert np.allclose(propagate(back_one, times).positions_km, propagate(one_burn, times).positions_km)
    restored = without_last_burn(one_burn)
    assert restored.propagation_model == MODEL_NUMERICAL and restored.segments == ()
    assert restored.position_basis == primary.position_basis
    assert np.allclose(propagate(restored, times).positions_km, propagate(primary, times).positions_km)
    orig = original_of(two_burns)
    assert orig.propagation_model == MODEL_NUMERICAL and orig.segments == ()
    assert np.allclose(propagate(orig, times).positions_km, propagate(primary, times).positions_km)
    assert original_of(primary) is primary


def test_summary_lists_burns(two_burns, primary):
    d = two_burns.summary()
    assert d["propagation_model"] == MODEL_PIECEWISE and d["base_model"] == MODEL_NUMERICAL
    assert [b["maneuver_id"] for b in d["burns"]] == ["MV-TEST-001", "MV-TEST-002"]
    assert d["burns"][0]["burn_time_unix"] == T0 + 3000.0 and d["burns"][0]["direction"] == "+T"
    assert d["spawned_at"] is None and d["spawned_at_unix"] is None
    assert primary.summary()["burns"] == []


def test_catalog_add_replace_and_version(primary, one_burn, synthetic_catalog):
    other = synthetic_catalog.require(synthetic.SECONDARY_ID)
    cat = Catalog([primary])
    v0 = cat.version
    cat.add(other)
    assert cat.version == v0 + 1 and other.object_id in cat
    with pytest.raises(ValueError):
        cat.add(other)
    cat.replace(one_burn)
    assert cat.version == v0 + 2 and cat.require(primary.object_id) is one_burn
    cat.replace(primary, bump_version=False)
    assert cat.version == v0 + 2 and cat.require(primary.object_id) is primary
    with pytest.raises(KeyError):
        cat.replace(synthetic_catalog.require("SYN-SAT-A"))
    # iteration is over a snapshot: adding while iterating must not raise
    for o in cat.values():
        if "SYN-RB-7" not in cat:
            cat.add(synthetic_catalog.require("SYN-RB-7"))
    assert len(cat) == 3
