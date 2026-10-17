import json
from pathlib import Path

import numpy as np
import pytest

from app.perception.features import FEATURE_NAMES
from app.perception.model import (ModelInfo, NullRiskModel, available_libraries, clear_model_cache, fit_model,
                                  load_risk_model, save_artifact, write_meta)

LIBS = available_libraries()


def _planted(n=3000, seed=0):
    rng = np.random.default_rng(seed)
    X = rng.normal(size=(n, len(FEATURE_NAMES)))
    y = (X[:, FEATURE_NAMES.index("dr_node_min_abs_km")] + 0.3 * X[:, FEATURE_NAMES.index("overlap_depth_km")] < -0.4).astype(int)
    return X, y


def test_missing_metadata_gives_null_model(tmp_path):
    clear_model_cache()
    m = load_risk_model(tmp_path / "nope.meta.json")
    assert isinstance(m, NullRiskModel) and m.info.status == "UNAVAILABLE" and "not found" in m.info.reason
    assert m.predict_proba(np.zeros((2, len(FEATURE_NAMES)))) is None


def test_feature_contract_mismatch_gives_null_model(tmp_path):
    info = ModelInfo(model_version="x", feature_names=["wrong"], artifacts={"sklearn": {"file": "nope"}})
    write_meta(info, tmp_path / "perception_risk.meta.json")
    clear_model_cache()
    m = load_risk_model(tmp_path / "perception_risk.meta.json")
    assert m.info.status == "UNAVAILABLE" and "contract" in m.info.reason


@pytest.mark.parametrize("library", ["xgboost", "sklearn"])
def test_round_trip(tmp_path, library):
    if not LIBS.get(library):
        pytest.skip(f"{library} not importable")
    X, y = _planted()
    est, lib, version = fit_model(X[:2000], y[:2000], library=library, X_val=X[2000:], y_val=y[2000:])
    path = save_artifact(est, lib, tmp_path)
    write_meta(ModelInfo(model_version="test", artifacts={lib: {"file": path.name, "library_version": version, "threshold": 0.5}}),
               tmp_path / "perception_risk.meta.json")
    clear_model_cache()
    m = load_risk_model(tmp_path / "perception_risk.meta.json")
    assert m.info.status == "LOADED" and m.info.library == lib and m.info.artifact == path.name
    pr = m.predict_proba(X[2000:])
    assert pr.shape == (1000,) and ((pr > 0.5) == y[2000:]).mean() > 0.9
    assert m.predict_proba(np.zeros((0, len(FEATURE_NAMES)))).shape == (0,)
    meta = json.loads((tmp_path / "perception_risk.meta.json").read_text())
    assert meta["feature_names"] == FEATURE_NAMES


def test_loader_prefers_primary_then_falls_back(tmp_path):
    if not LIBS.get("sklearn"):
        pytest.skip("sklearn not importable")
    X, y = _planted(1500)
    est, lib, version = fit_model(X, y, library="sklearn")
    path = save_artifact(est, lib, tmp_path)
    info = ModelInfo(model_version="t", artifacts={"xgboost": {"file": "missing.json", "library_version": "0"},
                                                    "sklearn": {"file": path.name, "library_version": version}})
    meta = info.to_dict()
    meta["primary_library"] = "xgboost"
    (tmp_path / "perception_risk.meta.json").write_text(json.dumps(meta))
    clear_model_cache()
    m = load_risk_model(tmp_path / "perception_risk.meta.json")
    assert m.info.status == "LOADED" and m.info.library == "sklearn" and "xgboost" in (m.info.reason or "")
