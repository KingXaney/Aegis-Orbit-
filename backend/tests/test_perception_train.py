import numpy as np
import pytest

from app.perception.dataset import Dataset
from app.perception.features import FEATURE_NAMES
from app.perception.model import available_libraries
from app.perception.train import choose_threshold, evaluate, make_labels, split_by_primary, train_and_save, train_model

LIBS = available_libraries()


def _planted_dataset(n_primaries=12, per_primary=400, seed=0) -> Dataset:
    rng = np.random.default_rng(seed)
    n = n_primaries * per_primary
    X = rng.normal(size=(n, len(FEATURE_NAMES))).astype(np.float32)
    k = FEATURE_NAMES.index("dr_node_min_abs_km")
    # distance grows with the planted feature; a few pairs end up critical
    d = np.abs(X[:, k]) * 30.0 + rng.normal(scale=2.0, size=n)
    d = np.clip(d, 0.05, None)
    group = np.repeat(np.arange(n_primaries), per_primary)
    return Dataset(X, d, np.zeros(n), np.full(n, 7.5), group, [f"P{i}" for i in range(n_primaries)],
                   [f"S{i}" for i in range(n)], {"groups": ["test"], "retrieved_at": {"test": "2026-10-17T00:00:00Z"}})


def test_split_by_primary_is_disjoint_and_grouped():
    ds = _planted_dataset()
    tr, va, te = split_by_primary(ds.group, seed=1)
    assert set(tr).isdisjoint(va) and set(tr).isdisjoint(te) and set(va).isdisjoint(te)
    assert len(tr) + len(va) + len(te) == len(ds.group)
    assert set(ds.group[tr]).isdisjoint(ds.group[va]) and set(ds.group[va]).isdisjoint(ds.group[te])


def test_choose_threshold_meets_recall_targets():
    rng = np.random.default_rng(0)
    d = rng.uniform(0, 100, 5000)
    scores = np.clip(1.0 - d / 100.0 + rng.normal(scale=0.05, size=5000), 0, 1)
    thr, basis = choose_threshold(scores, d, critical_km=5.0, label_radius_km=25.0)
    flagged = scores >= thr
    assert (flagged & (d < 5)).sum() / (d < 5).sum() >= 0.99
    assert (flagged & (d < 25)).sum() / (d < 25).sum() >= 0.95
    assert "recall" in basis
    thr0, basis0 = choose_threshold(np.array([0.1, 0.2]), np.array([50.0, 60.0]))
    assert thr0 == 0.5 and "no positive" in basis0


def test_evaluate_reports_the_expected_keys():
    rng = np.random.default_rng(1)
    d = rng.uniform(0, 100, 2000)
    scores = 1.0 - d / 100.0
    m = evaluate(scores, d, np.repeat(np.arange(4), 500), threshold=0.75)
    assert m["recall_tracked_at_threshold"] == 1.0 and m["roc_auc_tracked"] > 0.99
    assert "pr_auc_critical" in m and len(m["reliability"]) == 10 and m["confusion_tracked"]["fn"] == 0
    assert make_labels(np.array([1.0, 30.0]), 25.0).tolist() == [True, False]


@pytest.mark.parametrize("library", ["xgboost", "sklearn"])
def test_train_model_learns_planted_rule(library):
    if not LIBS.get(library):
        pytest.skip(f"{library} not importable")
    ds = _planted_dataset()
    tm = train_model(ds, library=library, seed=0)
    assert tm.library == library and tm.metrics["validation"]["roc_auc_tracked"] > 0.9
    assert tm.metrics["test"]["recall_critical_at_threshold"] >= 0.9
    assert "dr_node_min_abs_km" in list(tm.feature_importance)[:3]


def test_train_and_save_writes_artifacts_and_meta(tmp_path):
    libs = [lib for lib in ("xgboost", "sklearn") if LIBS.get(lib)]
    if not libs:
        pytest.skip("no ML library importable")
    ds = _planted_dataset(n_primaries=8, per_primary=300)
    info = train_and_save(ds, tmp_path, libraries=libs, seed=0, log=lambda *a: None)
    assert info.status == "LOADED" and info.library == libs[0] and set(info.artifacts) == set(libs)
    assert (tmp_path / "perception_risk.meta.json").exists() and (tmp_path / "perception_training_report.json").exists()
    assert info.training["positives_tracked"] > 0 and info.threshold is not None
