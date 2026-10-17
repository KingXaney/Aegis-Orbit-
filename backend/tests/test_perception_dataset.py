from dataclasses import replace

import numpy as np

from app.perception.dataset import (STATUS_CO_ORBITAL, STATUS_OK, build_dataset, candidate_pool, label_pairs,
                                    select_primaries)
from app.scenarios import real, synthetic


def test_labeller_reproduces_the_designed_conjunction(synthetic_catalog, synthetic_window):
    primary = synthetic_catalog.require(synthetic.PRIMARY_ID)
    others = synthetic_catalog.others(synthetic.PRIMARY_ID)
    lab = label_pairs(primary, others, synthetic_window["start_unix"], horizon_s=6 * 3600.0)
    k = [o.object_id for o in others].index(synthetic.SECONDARY_ID)
    designed = float(np.hypot(synthetic.MISS_HORIZONTAL_KM, synthetic.MISS_RADIAL_KM))
    assert lab.status[k] == STATUS_OK
    assert abs(lab.d_min_km[k] - designed) < 2e-3
    assert abs(lab.tca_unix[k] - (synthetic.T0_UNIX + synthetic.TCA_OFFSET_S)) < 1.0
    assert 7.0 < lab.rel_speed_kms[k] < 8.5 and lab.n_minima[k] >= 1
    for i, o in enumerate(others):
        if o.object_id != synthetic.SECONDARY_ID:
            assert lab.d_min_km[i] > 25.0


def test_labeller_flags_co_orbital_twin(synthetic_catalog, synthetic_window):
    primary = synthetic_catalog.require(synthetic.PRIMARY_ID)
    twin = replace(primary, object_id="TWIN")
    lab = label_pairs(primary, [twin], synthetic_window["start_unix"], horizon_s=3600.0)
    assert lab.status[0] == STATUS_CO_ORBITAL


def test_select_primaries_is_deterministic_and_respects_exclusions():
    cat = real.load_fixture_catalog()
    a = select_primaries(cat.values(), 12, seed=7, max_epoch_age_days=60)
    b = select_primaries(cat.values(), 12, seed=7, max_epoch_age_days=60)
    assert [o.object_id for o in a] == [o.object_id for o in b] and len(a) == 12
    assert all(o.norad_id != 25544 and o.category == "PAYLOAD" for o in a)
    c = select_primaries(cat.values(), 12, seed=8, max_epoch_age_days=60)
    assert [o.object_id for o in c] != [o.object_id for o in a]


def test_build_dataset_small_real_subset():
    cat = real.load_fixture_catalog()
    objects = cat.values()
    primaries = select_primaries(objects, 2, seed=3, max_epoch_age_days=60)
    ds = build_dataset(objects, primaries, band_margin_km=60.0, max_candidates=80, horizon_s=2 * 3600.0, seed=3, workers=1)
    assert ds.X.shape[0] == len(ds.d_min_km) == len(ds.secondary_ids) and ds.X.shape[0] > 0
    assert np.isfinite(ds.X).all() and np.isfinite(ds.d_min_km).all()
    assert set(np.unique(ds.group)) <= {0, 1} and ds.meta["n_primaries"] == 2
    pool = candidate_pool(primaries[0], objects, 60.0, 80)
    assert 0 < len(pool) <= 80
