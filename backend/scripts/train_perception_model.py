"""Train the collision-risk ranker from CelesTrak data.

    .venv/bin/python scripts/train_perception_model.py --primaries 150 --max-candidates 3000 --workers 6 \
        --out data/models [--refresh] [--reuse-dataset data/models/perception_dataset.npz]

Downloads the configured CelesTrak groups when the cache is empty, samples LEO
primaries, labels every candidate pair with the physics screening, trains the
available gradient-boosting libraries (XGBoost preferred, scikit-learn twin)
and writes the artifacts, metadata and a training report.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.perception.dataset import Dataset, build_dataset, load_training_catalog, select_primaries  # noqa: E402
from app.perception.train import train_and_save  # noqa: E402


def main() -> None:
    s = get_settings()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--groups", default=",".join(s.perception_training_group_list))
    ap.add_argument("--primaries", type=int, default=150)
    ap.add_argument("--max-candidates", type=int, default=3000)
    ap.add_argument("--band-margin-km", type=float, default=150.0)
    ap.add_argument("--horizon-hours", type=float, default=24.0)
    ap.add_argument("--coarse-step-s", type=float, default=30.0)
    ap.add_argument("--label-radius-km", type=float, default=25.0)
    ap.add_argument("--critical-km", type=float, default=5.0)
    ap.add_argument("--max-epoch-age-days", type=float, default=10.0)
    ap.add_argument("--exclude-norad", default="25544")
    ap.add_argument("--seed", type=int, default=20261017)
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--library", default="both", choices=["both", "xgboost", "sklearn"])
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "data" / "models"))
    ap.add_argument("--refresh", action="store_true", help="re-download the CelesTrak groups")
    ap.add_argument("--reuse-dataset", default=None, help="skip labelling and train on an existing .npz")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()

    if args.reuse_dataset:
        ds = Dataset.load(Path(args.reuse_dataset))
        print(f"loaded dataset {args.reuse_dataset}: {len(ds.d_min_km)} rows from {len(ds.primary_ids)} primaries")
    else:
        groups = [g.strip() for g in args.groups.split(",") if g.strip()]
        objects, meta = load_training_catalog(groups, refresh=args.refresh)
        print(f"catalog: {meta['records']} objects from {groups} (rejected {meta['rejected']}); retrieved {meta['retrieved_at']}")
        exclude = [int(x) for x in args.exclude_norad.split(",") if x.strip()]
        primaries = select_primaries(objects, args.primaries, args.seed, max_epoch_age_days=args.max_epoch_age_days,
                                     exclude_norad=exclude)
        print(f"selected {len(primaries)} primaries (stratified by altitude x inclination)")

        def progress(i, n, r):
            if i % 10 == 0 or i == n:
                print(f"  labelled {i}/{n} primaries ({time.time() - t0:.0f}s): last {r['primary_id']} "
                      f"{r['n_candidates']} candidates, {len(r['d_min'])} rows", flush=True)

        ds = build_dataset(objects, primaries, band_margin_km=args.band_margin_km, max_candidates=args.max_candidates,
                           horizon_s=args.horizon_hours * 3600.0, coarse_step_s=args.coarse_step_s,
                           label_radius_km=args.label_radius_km, seed=args.seed, workers=args.workers, progress=progress,
                           meta={**meta, "exclude_norad": exclude,
                                 "primary_selection": {"n": args.primaries, "max_epoch_age_days": args.max_epoch_age_days}})
        ds.save(out / "perception_dataset.npz")
        print(f"dataset: {len(ds.d_min_km)} pairs, {int((ds.d_min_km < args.label_radius_km).sum())} within "
              f"{args.label_radius_km:g} km, {int((ds.d_min_km < args.critical_km).sum())} within {args.critical_km:g} km "
              f"({ds.meta['duration_s']}s)")

    libraries = ("xgboost", "sklearn") if args.library == "both" else (args.library,)
    info = train_and_save(ds, out, libraries=libraries, label_radius_km=args.label_radius_km, critical_km=args.critical_km,
                          seed=args.seed)
    print(f"primary library: {info.library} {info.library_version}; model {info.model_version}; threshold {info.threshold:.3f}")
    print("top features:", ", ".join(f"{k} {v:.2f}" for k, v in list(info.feature_importance.items())[:10]))
    for lib, art in info.artifacts.items():
        m = art["metrics"].get("test") or art["metrics"]["validation"]
        print(f"  {lib}: test PR-AUC(tracked) {m.get('pr_auc_tracked', float('nan')):.3f}, "
              f"ROC-AUC {m.get('roc_auc_tracked', float('nan')):.3f}, recall(critical)@thr {m.get('recall_critical_at_threshold', float('nan')):.3f}, "
              f"flagged {m['flagged_fraction']:.3f}, {art['metrics']['artifact_bytes'] // 1024} kB")
    print(f"wrote {out}/perception_risk.meta.json and artifacts in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
