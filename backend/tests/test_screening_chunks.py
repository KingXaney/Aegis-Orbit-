"""Chunked candidate propagation in screen() must not change what the screening finds."""
import numpy as np

from app.physics import screening
from app.scenarios import synthetic
from app.simulation.session import SessionStore


def _scenario():
    return SessionStore().get(synthetic.SCENARIO_ID).scenario


def _run(scen):
    primary = scen.catalog.require(scen.primary_id)
    res = screening.screen(primary, scen.catalog.others(scen.primary_id), scen.start_unix, scen.end_unix)
    return sorted((c.secondary_id, round(c.miss_distance_km, 6), round(c.tca_unix, 3)) for c in res.conjunctions), res.stats


def test_chunk_size_does_not_change_the_result(monkeypatch):
    scen = _scenario()
    whole, stats_whole = _run(scen)
    monkeypatch.setattr(screening, "PROPAGATION_CHUNK", 1)
    one_at_a_time, stats_one = _run(scen)
    assert whole and whole == one_at_a_time
    assert stats_whole["objects_valid"] == stats_one["objects_valid"]


def test_chunked_propagation_walks_objects_in_order_with_one_chunk_resident(monkeypatch):
    scen = _scenario()
    objects = scen.catalog.others(scen.primary_id)
    times = np.array([scen.start_unix, scen.start_unix + 60.0])
    calls = []
    real = screening.propagate_batch

    def spy(objs, t, step):
        calls.append(len(list(objs)))
        return real(objs, t, step)

    monkeypatch.setattr(screening, "propagate_batch", spy)
    lazy = screening._ChunkedPropagation(objects, times, 10.0, chunk=2)
    for o in objects:
        assert lazy[o.object_id].positions_km.shape == (2, 3)
    assert len(calls) == -(-len(objects) // 2)  # ceil(n / 2) propagations
    assert all(n <= 2 for n in calls)
