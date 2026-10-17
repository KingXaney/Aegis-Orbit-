"""Risk-model abstraction and persistence.

Two gradient-boosted implementations share one interface: XGBoost (preferred)
and scikit-learn's HistGradientBoostingClassifier (twin artifact, used when
xgboost cannot be imported, e.g. macOS without an OpenMP runtime). When no
artifact loads, a NullRiskModel reports why and the perception layer runs
physics-only. Nothing here raises on load failures.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol, Tuple

import numpy as np

from ..config import get_settings
from .features import FEATURE_NAMES, FEATURE_VERSION

ARTIFACT_FILES = {"xgboost": "perception_risk.xgb.json", "sklearn": "perception_risk.sklearn.joblib"}
LIBRARY_ORDER = ["xgboost", "sklearn"]

XGB_PARAMS: Dict[str, Any] = {"tree_method": "hist", "max_depth": 6, "n_estimators": 400, "learning_rate": 0.05,
                              "subsample": 0.8, "colsample_bytree": 0.8, "min_child_weight": 5,
                              "eval_metric": "aucpr", "objective": "binary:logistic", "n_jobs": 4}
SKL_PARAMS: Dict[str, Any] = {"max_iter": 400, "learning_rate": 0.05, "max_leaf_nodes": 31, "min_samples_leaf": 20,
                              "l2_regularization": 0.1, "class_weight": "balanced", "early_stopping": False}


@dataclass
class ModelInfo:
    status: str = "UNAVAILABLE"  # LOADED | UNAVAILABLE
    library: Optional[str] = None
    library_version: Optional[str] = None
    model_version: Optional[str] = None
    artifact: Optional[str] = None
    feature_version: int = FEATURE_VERSION
    feature_names: List[str] = field(default_factory=lambda: list(FEATURE_NAMES))
    trained_at: Optional[str] = None
    data_retrieved_at: Dict[str, str] = field(default_factory=dict)
    training: Dict[str, Any] = field(default_factory=dict)
    metrics: Dict[str, Any] = field(default_factory=dict)
    feature_importance: Dict[str, float] = field(default_factory=dict)
    threshold: Optional[float] = None
    threshold_basis: Optional[str] = None
    artifacts: Dict[str, Any] = field(default_factory=dict)
    reason: Optional[str] = None
    basis: str = "MODEL_ESTIMATE"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class RiskModel(Protocol):
    info: ModelInfo

    def predict_proba(self, X: np.ndarray) -> Optional[np.ndarray]: ...


class NullRiskModel:
    def __init__(self, reason: str, info: Optional[ModelInfo] = None):
        self.info = info or ModelInfo()
        self.info.status = "UNAVAILABLE"
        self.info.reason = reason

    def predict_proba(self, X: np.ndarray) -> Optional[np.ndarray]:
        return None


class XGBoostRiskModel:
    def __init__(self, booster: Any, info: ModelInfo):
        self.booster = booster
        self.info = info

    def predict_proba(self, X: np.ndarray) -> Optional[np.ndarray]:
        X = np.asarray(X, dtype=np.float32)
        if X.size == 0:
            return np.zeros(0)
        return np.asarray(self.booster.inplace_predict(X), dtype=float)


class SklearnRiskModel:
    def __init__(self, estimator: Any, info: ModelInfo):
        self.estimator = estimator
        self.info = info

    def predict_proba(self, X: np.ndarray) -> Optional[np.ndarray]:
        X = np.asarray(X, dtype=np.float64)
        if X.size == 0:
            return np.zeros(0)
        return np.asarray(self.estimator.predict_proba(X)[:, 1], dtype=float)


def available_libraries() -> Dict[str, Optional[str]]:
    """Importable ML libraries with versions (None when import fails for any reason)."""
    out: Dict[str, Optional[str]] = {}
    try:
        import xgboost  # noqa: F401
        out["xgboost"] = xgboost.__version__
    except Exception:  # XGBoostError (missing libomp) is not an ImportError
        out["xgboost"] = None
    try:
        import sklearn  # noqa: F401
        out["sklearn"] = sklearn.__version__
    except Exception:
        out["sklearn"] = None
    return out


def fit_model(X: np.ndarray, y: np.ndarray, library: str = "auto", params: Optional[Dict[str, Any]] = None,
              seed: int = 0, X_val: Optional[np.ndarray] = None, y_val: Optional[np.ndarray] = None,
              early_stopping_rounds: int = 50) -> Tuple[Any, str, str]:
    """Train one classifier. Returns (estimator, library, library_version)."""
    libs = available_libraries()
    if library == "auto":
        library = "xgboost" if libs.get("xgboost") else "sklearn"
    if not libs.get(library):
        raise RuntimeError(f"library '{library}' is not importable: {libs}")
    y = np.asarray(y).astype(int)
    if library == "xgboost":
        import xgboost as xgb
        p = dict(XGB_PARAMS)
        n_pos = max(int(y.sum()), 1)
        p["scale_pos_weight"] = float(min(len(y) - n_pos, 100 * n_pos) / n_pos)
        p["random_state"] = seed
        if X_val is not None and y_val is not None:
            p["early_stopping_rounds"] = early_stopping_rounds
        p.update(params or {})
        clf = xgb.XGBClassifier(**p)
        if X_val is not None and y_val is not None:
            clf.fit(X, y, eval_set=[(X_val, np.asarray(y_val).astype(int))], verbose=False)
        else:
            clf.fit(X, y)
        return clf, "xgboost", xgb.__version__
    import sklearn
    from sklearn.ensemble import HistGradientBoostingClassifier
    p = dict(SKL_PARAMS)
    p["random_state"] = seed
    p.update(params or {})
    clf = HistGradientBoostingClassifier(**p)
    clf.fit(X, y)
    return clf, "sklearn", sklearn.__version__


def save_artifact(estimator: Any, library: str, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / ARTIFACT_FILES[library]
    if library == "xgboost":
        estimator.get_booster().save_model(str(path))
    else:
        import joblib
        joblib.dump(estimator, path, compress=3)
    return path


def write_meta(info: ModelInfo, meta_path: Path) -> None:
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(info.to_dict(), indent=2) + "\n", encoding="utf-8")


def _load_artifact(library: str, path: Path):
    if library == "xgboost":
        import xgboost as xgb
        booster = xgb.Booster()
        booster.load_model(str(path))
        return booster
    import joblib
    return joblib.load(path)


@lru_cache(maxsize=8)
def _load_cached(meta_path_str: str):
    meta_path = Path(meta_path_str)
    if not meta_path.exists():
        return NullRiskModel(f"model metadata not found at {meta_path}; perception runs physics-only")
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return NullRiskModel(f"could not read model metadata: {exc}")
    info = ModelInfo(**{k: v for k, v in meta.items() if k in ModelInfo.__dataclass_fields__})
    if info.feature_version != FEATURE_VERSION or list(info.feature_names) != list(FEATURE_NAMES):
        return NullRiskModel("feature contract mismatch between the model metadata and this code; retrain the model", info)
    libs = available_libraries()
    reasons: List[str] = []
    primary = meta.get("primary_library")
    order = ([primary] if primary in LIBRARY_ORDER else []) + [lib for lib in LIBRARY_ORDER if lib != primary]
    for lib in order:
        art = (info.artifacts or {}).get(lib)
        if not art:
            continue
        if not libs.get(lib):
            reasons.append(f"{lib}: library not importable")
            continue
        path = meta_path.parent / art.get("file", ARTIFACT_FILES[lib])
        if not path.exists():
            reasons.append(f"{lib}: artifact {path.name} missing")
            continue
        try:
            est = _load_artifact(lib, path)
        except Exception as exc:  # corrupt/incompatible artifact
            reasons.append(f"{lib}: failed to load ({exc})")
            continue
        info.status = "LOADED"
        info.library = lib
        info.library_version = libs.get(lib)
        info.artifact = path.name
        info.metrics = art.get("metrics", info.metrics)
        info.threshold = art.get("threshold", info.threshold)
        info.threshold_basis = art.get("threshold_basis", info.threshold_basis)
        info.feature_importance = art.get("feature_importance", info.feature_importance)
        info.reason = ("; ".join(reasons) + "; " if reasons else "") + (
            f"trained with {lib} {art.get('library_version')}, running with {libs.get(lib)}"
            if art.get("library_version") and art.get("library_version") != libs.get(lib) else "") or None
        return XGBoostRiskModel(est, info) if lib == "xgboost" else SklearnRiskModel(est, info)
    return NullRiskModel("no loadable artifact: " + ("; ".join(reasons) or "metadata lists no artifacts"), info)


def load_risk_model(meta_path: Optional[Path] = None) -> RiskModel:
    path = Path(meta_path) if meta_path is not None else get_settings().perception_model_meta_file
    return _load_cached(str(path.resolve()))


def clear_model_cache() -> None:
    _load_cached.cache_clear()
