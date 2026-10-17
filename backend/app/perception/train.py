"""Training, evaluation and persistence of the collision-risk ranker."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from ..physics.time_utils import iso
from .dataset import Dataset
from .features import FEATURE_NAMES, FEATURE_VERSION
from .model import ARTIFACT_FILES, ModelInfo, available_libraries, fit_model, save_artifact, write_meta

PREFERENCE = ["xgboost", "sklearn"]


@dataclass
class TrainedModel:
    estimator: Any
    library: str
    library_version: str
    threshold: float
    threshold_basis: str
    metrics: Dict[str, Any]
    feature_importance: Dict[str, float]
    split_sizes: Dict[str, int]
    train_seconds: float = 0.0


def split_by_primary(group: np.ndarray, fractions: Sequence[float] = (0.6, 0.2, 0.2), seed: int = 0):
    """Disjoint train/val/test row indices, grouped by primary."""
    groups = np.unique(group)
    rng = np.random.default_rng(seed)
    perm = rng.permutation(groups)
    n = len(perm)
    n_train = max(1, int(round(fractions[0] * n)))
    n_val = max(1, int(round(fractions[1] * n))) if n >= 3 else 0
    n_train = min(n_train, n - n_val - (1 if n >= 3 else 0))
    train_g, val_g, test_g = perm[:n_train], perm[n_train:n_train + n_val], perm[n_train + n_val:]
    idx = lambda gs: np.nonzero(np.isin(group, gs))[0]  # noqa: E731
    return idx(train_g), idx(val_g), idx(test_g)


def make_labels(d_min_km: np.ndarray, label_radius_km: float = 25.0) -> np.ndarray:
    return np.asarray(d_min_km) < label_radius_km


def choose_threshold(scores: np.ndarray, d_min_km: np.ndarray, critical_km: float = 5.0, label_radius_km: float = 25.0,
                     target_critical_recall: float = 0.99, target_tracked_recall: float = 0.95) -> Tuple[float, str]:
    """Largest score threshold that keeps the required recall of critical and tracked pairs."""
    scores = np.asarray(scores)
    d = np.asarray(d_min_km)
    crit = d < critical_km
    tracked = d < label_radius_km
    if crit.sum() == 0 and tracked.sum() == 0:
        return 0.5, "no positive pairs in the calibration split; default threshold 0.5"
    order = np.argsort(-scores)
    cum_c = np.cumsum(crit[order])
    cum_t = np.cumsum(tracked[order])
    need_c = target_critical_recall * max(crit.sum(), 1)
    need_t = target_tracked_recall * max(tracked.sum(), 1)
    ok = (cum_c >= need_c) & (cum_t >= need_t)
    if not ok.any():
        return float(scores.min()), "could not reach the recall targets; threshold set to the minimum score"
    k = int(np.argmax(ok))
    thr = float(scores[order][k])
    return thr, (f"largest threshold with >= {target_critical_recall:.0%} recall of pairs closer than {critical_km:g} km "
                 f"and >= {target_tracked_recall:.0%} of pairs closer than {label_radius_km:g} km (calibration split)")


def evaluate(scores: np.ndarray, d_min_km: np.ndarray, group: np.ndarray, threshold: float, critical_km: float = 5.0,
             label_radius_km: float = 25.0) -> Dict[str, Any]:
    from sklearn.metrics import average_precision_score, roc_auc_score
    scores = np.asarray(scores)
    d = np.asarray(d_min_km)
    y_t = d < label_radius_km
    y_c = d < critical_km
    flagged = scores >= threshold
    out: Dict[str, Any] = {"n": int(len(d)), "positives_tracked": int(y_t.sum()), "positives_critical": int(y_c.sum()),
                           "threshold": float(threshold), "flagged_fraction": float(flagged.mean()) if len(d) else 0.0}
    if 0 < y_t.sum() < len(y_t):
        out["roc_auc_tracked"] = float(roc_auc_score(y_t, scores))
        out["pr_auc_tracked"] = float(average_precision_score(y_t, scores))
        out["recall_tracked_at_threshold"] = float((flagged & y_t).sum() / y_t.sum())
        out["precision_tracked_at_threshold"] = float((flagged & y_t).sum() / max(flagged.sum(), 1))
    if 0 < y_c.sum() < len(y_c):
        out["roc_auc_critical"] = float(roc_auc_score(y_c, scores))
        out["pr_auc_critical"] = float(average_precision_score(y_c, scores))
        out["recall_critical_at_threshold"] = float((flagged & y_c).sum() / y_c.sum())
    # per-primary top-K% recall of critical pairs
    topk: Dict[str, float] = {}
    for frac in (0.05, 0.10, 0.20):
        hits, total = 0, 0
        for g in np.unique(group):
            m = group == g
            if y_c[m].sum() == 0:
                continue
            k = max(1, int(np.ceil(frac * m.sum())))
            top = np.argsort(-scores[m])[:k]
            hits += int(y_c[m][top].sum())
            total += int(y_c[m].sum())
        if total:
            topk[f"top{int(frac * 100)}pct"] = hits / total
    out["per_primary_critical_recall"] = topk
    # reliability: observed tracked rate per score decile
    bins = np.linspace(0.0, 1.0, 11)
    which = np.clip(np.digitize(scores, bins) - 1, 0, 9)
    out["reliability"] = [{"bin": f"{bins[i]:.1f}-{bins[i + 1]:.1f}", "n": int((which == i).sum()),
                           "mean_score": float(scores[which == i].mean()) if (which == i).any() else None,
                           "observed_tracked_rate": float(y_t[which == i].mean()) if (which == i).any() else None}
                          for i in range(10)]
    out["confusion_tracked"] = {"tp": int((flagged & y_t).sum()), "fp": int((flagged & ~y_t).sum()),
                                "fn": int((~flagged & y_t).sum()), "tn": int((~flagged & ~y_t).sum())}
    return out


def feature_importance(estimator: Any, library: str, X_val: np.ndarray, y_val: np.ndarray, names: Sequence[str],
                       seed: int = 0, max_rows: int = 50000) -> Dict[str, float]:
    if library == "xgboost":
        raw = estimator.get_booster().get_score(importance_type="gain")
        total = sum(raw.values()) or 1.0
        out: Dict[str, float] = {}
        for key, val in raw.items():
            name = names[int(key[1:])] if key.startswith("f") and key[1:].isdigit() else key
            out[name] = float(val / total)
        return dict(sorted(out.items(), key=lambda kv: -kv[1]))
    from sklearn.inspection import permutation_importance
    rng = np.random.default_rng(seed)
    if len(y_val) > max_rows:
        sel = rng.choice(len(y_val), size=max_rows, replace=False)
        X_val, y_val = X_val[sel], y_val[sel]
    res = permutation_importance(estimator, X_val, y_val, n_repeats=3, scoring="average_precision", random_state=seed, n_jobs=1)
    imp = {names[i]: float(max(res.importances_mean[i], 0.0)) for i in range(len(names))}
    total = sum(imp.values()) or 1.0
    return dict(sorted(((k, v / total) for k, v in imp.items()), key=lambda kv: -kv[1]))


def train_model(ds: Dataset, library: str = "auto", label_radius_km: float = 25.0, critical_km: float = 5.0,
                seed: int = 0, params: Optional[Dict[str, Any]] = None) -> TrainedModel:
    tr, va, te = split_by_primary(ds.group, seed=seed)
    y = make_labels(ds.d_min_km, label_radius_km).astype(int)
    X = ds.X.astype(np.float32)
    t0 = time.time()
    est, lib, version = fit_model(X[tr], y[tr], library=library, params=params, seed=seed,
                                  X_val=X[va] if len(va) else None, y_val=y[va] if len(va) else None)
    dt = time.time() - t0
    calib = va if len(va) else tr
    s_calib = est.predict_proba(X[calib])[:, 1]
    thr, basis = choose_threshold(s_calib, ds.d_min_km[calib], critical_km, label_radius_km)
    metrics = {"validation": evaluate(s_calib, ds.d_min_km[calib], ds.group[calib], thr, critical_km, label_radius_km)}
    if len(te):
        s_test = est.predict_proba(X[te])[:, 1]
        metrics["test"] = evaluate(s_test, ds.d_min_km[te], ds.group[te], thr, critical_km, label_radius_km)
    imp = feature_importance(est, lib, X[calib], y[calib], FEATURE_NAMES, seed)
    return TrainedModel(est, lib, version, thr, basis, metrics, imp,
                        {"train": int(len(tr)), "validation": int(len(va)), "test": int(len(te))}, round(dt, 1))


def train_and_save(ds: Dataset, out_dir: Path, libraries: Sequence[str] = ("xgboost", "sklearn"), label_radius_km: float = 25.0,
                   critical_km: float = 5.0, seed: int = 0, model_version: Optional[str] = None,
                   log=print) -> ModelInfo:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    libs = available_libraries()
    trained: Dict[str, TrainedModel] = {}
    for lib in libraries:
        if not libs.get(lib):
            log(f"skipping {lib}: not importable")
            continue
        log(f"training {lib} {libs[lib]} ...")
        tm = train_model(ds, lib, label_radius_km, critical_km, seed)
        path = save_artifact(tm.estimator, lib, out_dir)
        tm.metrics["artifact_bytes"] = path.stat().st_size
        trained[lib] = tm
        v = tm.metrics["validation"]
        log(f"  {lib}: {tm.train_seconds}s, PR-AUC(tracked) {v.get('pr_auc_tracked', float('nan')):.3f}, "
            f"recall(critical)@thr {v.get('recall_critical_at_threshold', float('nan')):.3f}, "
            f"flagged {v['flagged_fraction']:.3f}, threshold {tm.threshold:.3f}, artifact {path.stat().st_size // 1024} kB")
    if not trained:
        raise RuntimeError(f"no trainable library available: {libs}")
    primary = next(lib for lib in PREFERENCE if lib in trained)
    pm = trained[primary]
    stamp = datetime.now(timezone.utc)
    info = ModelInfo(
        status="LOADED", library=primary, library_version=pm.library_version,
        model_version=model_version or f"perception-risk-v{FEATURE_VERSION}-{stamp.strftime('%Y%m%d')}",
        artifact=ARTIFACT_FILES[primary], feature_version=FEATURE_VERSION, feature_names=list(FEATURE_NAMES),
        trained_at=iso(stamp), data_retrieved_at=dict(ds.meta.get("retrieved_at", {})),
        training={k: ds.meta.get(k) for k in ("groups", "n_primaries", "rows", "band_margin_km", "max_candidates", "horizon_s",
                                                "coarse_step_s", "label_radius_km", "seed", "failed_pairs", "co_orbital_pairs",
                                                "exclude_norad", "primary_selection")},
        metrics=pm.metrics, feature_importance=pm.feature_importance, threshold=pm.threshold, threshold_basis=pm.threshold_basis,
        artifacts={lib: {"file": ARTIFACT_FILES[lib], "library_version": tm.library_version, "threshold": tm.threshold,
                         "threshold_basis": tm.threshold_basis, "metrics": tm.metrics, "feature_importance": tm.feature_importance,
                         "split_sizes": tm.split_sizes, "train_seconds": tm.train_seconds} for lib, tm in trained.items()},
    )
    info.training.update({"critical_km": critical_km, "positives_tracked": int(make_labels(ds.d_min_km, label_radius_km).sum()),
                          "positives_critical": int((ds.d_min_km < critical_km).sum()), "split_sizes": pm.split_sizes,
                          "libraries_trained": list(trained)})
    meta = info.to_dict()
    meta["primary_library"] = primary
    import json
    (out_dir / "perception_risk.meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    report = {"model_version": info.model_version, "trained_at": info.trained_at, "dataset": ds.meta,
              "libraries": {lib: {"version": tm.library_version, "threshold": tm.threshold, "metrics": tm.metrics,
                                  "feature_importance": tm.feature_importance, "split_sizes": tm.split_sizes}
                            for lib, tm in trained.items()}, "primary_library": primary}
    (out_dir / "perception_training_report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return info
