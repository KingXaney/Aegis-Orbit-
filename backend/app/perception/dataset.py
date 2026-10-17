"""Training-set construction for the collision-risk ranker.

Labels come from the same physics the simulator uses: batched SGP4 propagation
of each sampled primary against its altitude-band candidates over a 24 h
window, sample-level local minima of the relative distance, and a fine 1 s grid
plus parabolic interpolation around each flagged minimum. The pipeline mirrors
``physics.screening.screen`` but is vectorised over candidates so that labelling
a few hundred thousand pairs takes minutes, not hours.
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from ..data import celestrak
from ..data.catalog import OrbitalObject
from ..data.tle import parse_tle_text
from ..physics.propagation import propagate, propagate_batch
from ..physics.screening import altitude_overlap_filter
from ..physics.time_utils import iso, parse_iso, time_grid
from .features import FEATURE_NAMES, FEATURE_VERSION, pair_features

ALT_BINS_KM = [300.0, 450.0, 600.0, 800.0, 1000.0, 1200.0]
INC_BINS_DEG = [0.0, 40.0, 70.0, 100.0, 180.0]
STATUS_OK, STATUS_FAILED, STATUS_CO_ORBITAL = "OK", "FAILED", "CO_ORBITAL"


@dataclass
class PairLabels:
    d_min_km: np.ndarray
    tca_unix: np.ndarray
    rel_speed_kms: np.ndarray
    status: np.ndarray  # object array of str
    n_minima: np.ndarray


@dataclass
class Dataset:
    X: np.ndarray  # (M, F) float32
    d_min_km: np.ndarray
    tca_unix: np.ndarray
    rel_speed_kms: np.ndarray
    group: np.ndarray  # (M,) index of the primary
    primary_ids: List[str]
    secondary_ids: List[str]
    meta: Dict[str, Any] = field(default_factory=dict)

    def save(self, path: Path) -> None:
        path = Path(path)
        np.savez_compressed(path, X=self.X, d_min_km=self.d_min_km, tca_unix=self.tca_unix,
                            rel_speed_kms=self.rel_speed_kms, group=self.group,
                            secondary_ids=np.asarray(self.secondary_ids))
        side = {"primary_ids": self.primary_ids, "meta": self.meta, "feature_names": FEATURE_NAMES,
                "feature_version": FEATURE_VERSION, "rows": int(len(self.d_min_km))}
        path.with_suffix(".meta.json").write_text(json.dumps(side, indent=2) + "\n")

    @classmethod
    def load(cls, path: Path) -> "Dataset":
        path = Path(path)
        z = np.load(path, allow_pickle=False)
        side = json.loads(path.with_suffix(".meta.json").read_text())
        if side.get("feature_names") != FEATURE_NAMES:
            raise ValueError("dataset feature contract differs from the current FEATURE_NAMES; rebuild it")
        return cls(z["X"], z["d_min_km"], z["tca_unix"], z["rel_speed_kms"], z["group"], side["primary_ids"],
                   [str(s) for s in z["secondary_ids"]], side.get("meta", {}))


# --------------------------------------------------------------------------
# catalog + sampling
# --------------------------------------------------------------------------

def load_training_catalog(groups: Sequence[str], refresh: bool = False) -> Tuple[List[OrbitalObject], Dict[str, Any]]:
    """All objects from the CelesTrak groups (first record per NORAD id wins) plus retrieval metadata."""
    by_norad: Dict[int, OrbitalObject] = {}
    retrieved: Dict[str, str] = {}
    rejected = 0
    for g in groups:
        text, meta = celestrak.load_group(g, refresh=refresh)
        retrieved[g] = meta.get("retrieved_at", "")
        objs, rej = parse_tle_text(text, source="celestrak", source_detail=f"GROUP={g}",
                                   retrieved_at=parse_iso(meta["retrieved_at"]) if meta.get("retrieved_at") else None)
        rejected += len(rej)
        for o in objs:
            by_norad.setdefault(o.norad_id, o)
    return list(by_norad.values()), {"groups": list(groups), "retrieved_at": retrieved,
                                     "records": len(by_norad), "rejected": rejected}


def select_primaries(objects: Sequence[OrbitalObject], n: int, seed: int, alt_range_km: Tuple[float, float] = (300.0, 1200.0),
                     max_e: float = 0.05, max_epoch_age_days: float = 10.0, reference_unix: Optional[float] = None,
                     exclude_norad: Sequence[int] = (25544,)) -> List[OrbitalObject]:
    """Deterministic, stratified (altitude x inclination) sample of LEO payloads."""
    if reference_unix is None:
        epochs = [o.epoch_unix for o in objects if o.epoch_unix]
        reference_unix = max(epochs) if epochs else 0.0
    excluded = set(int(x) for x in exclude_norad)
    pool = [o for o in objects if o.category == "PAYLOAD" and o.validation_status == "OK" and o.satrec is not None
            and o.norad_id not in excluded and o.perigee_alt_km is not None and o.apogee_alt_km is not None
            and alt_range_km[0] <= o.perigee_alt_km and o.apogee_alt_km <= alt_range_km[1]
            and float(o.satrec.ecco) <= max_e and (reference_unix - o.epoch_unix) / 86400.0 <= max_epoch_age_days]
    rng = np.random.default_rng(seed)
    bins: Dict[Tuple[int, int], List[OrbitalObject]] = {}
    for o in pool:
        alt = 0.5 * (o.perigee_alt_km + o.apogee_alt_km)
        ia = int(np.searchsorted(ALT_BINS_KM, alt, side="right") - 1)
        ii = int(np.searchsorted(INC_BINS_DEG, o.inclination_deg or 0.0, side="right") - 1)
        bins.setdefault((ia, ii), []).append(o)
    keys = sorted(bins)
    for k in keys:
        bins[k] = [bins[k][i] for i in rng.permutation(len(bins[k]))]
    chosen: List[OrbitalObject] = []
    while len(chosen) < n and any(bins[k] for k in keys):
        for k in keys:
            if bins[k] and len(chosen) < n:
                chosen.append(bins[k].pop())
    return chosen


def candidate_pool(primary: OrbitalObject, objects: Sequence[OrbitalObject], margin_km: float = 150.0,
                   max_candidates: int = 3000, rng: Optional[np.random.Generator] = None) -> List[OrbitalObject]:
    cands = [o for o in altitude_overlap_filter(primary, objects, margin_km) if o.validation_status != "INVALID"]
    if len(cands) > max_candidates:
        rng = rng or np.random.default_rng(0)
        idx = np.sort(rng.choice(len(cands), size=max_candidates, replace=False))
        cands = [cands[i] for i in idx]
    return cands


# --------------------------------------------------------------------------
# labelling
# --------------------------------------------------------------------------

def _parabolic_min(t: np.ndarray, d2: np.ndarray, i: int) -> Tuple[float, float]:
    """Vertex of the parabola through (t[i-1..i+1], d2[...]); returns (t*, d*)."""
    if i <= 0 or i >= len(t) - 1:
        return float(t[i]), float(np.sqrt(max(d2[i], 0.0)))
    h = t[i + 1] - t[i]
    denom = d2[i + 1] - 2.0 * d2[i] + d2[i - 1]
    if denom <= 1e-12:
        return float(t[i]), float(np.sqrt(max(d2[i], 0.0)))
    delta = 0.5 * (d2[i - 1] - d2[i + 1]) / denom
    delta = float(np.clip(delta, -1.0, 1.0))
    t_star = t[i] + delta * h
    d2_star = d2[i] - 0.125 * (d2[i + 1] - d2[i - 1]) ** 2 / denom  # vertex value of the parabola
    return float(t_star), float(np.sqrt(max(d2_star, 0.0)))


def label_pairs(primary: OrbitalObject, candidates: Sequence[OrbitalObject], t_start_unix: float,
                horizon_s: float = 86400.0, coarse_step_s: float = 30.0, fine_step_s: float = 1.0,
                fine_half_width_s: float = 45.0, screening_radius_km: float = 25.0,
                co_orbital_min_speed_kms: float = 0.01, chunk: int = 1000, max_rel_speed_kms: float = 16.0) -> PairLabels:
    """Minimum distance (km), its time and relative speed for every candidate over the window."""
    n = len(candidates)
    d_min = np.full(n, np.nan)
    tca = np.full(n, np.nan)
    speed_at = np.full(n, np.nan)
    status = np.array([STATUS_OK] * n, dtype=object)
    n_minima = np.zeros(n, dtype=int)
    if n == 0:
        return PairLabels(d_min, tca, speed_at, status, n_minima)
    times = time_grid(t_start_unix, t_start_unix + horizon_s, coarse_step_s)
    res_p = propagate(primary, times)
    if res_p.status == "FAILED":
        status[:] = STATUS_FAILED
        return PairLabels(d_min, tca, speed_at, status, n_minima)
    rp, vp = res_p.positions_km, res_p.velocities_kms
    fine_offsets = np.arange(-fine_half_width_s, fine_half_width_s + 1e-9, fine_step_s)
    for start in range(0, n, chunk):
        objs = list(candidates[start:start + chunk])
        results = propagate_batch(objs, times)
        R = np.stack([results[o.object_id].positions_km for o in objs])  # (C, T, 3)
        V = np.stack([results[o.object_id].velocities_kms for o in objs])
        D = np.linalg.norm(R - rp[None, :, :], axis=2)
        S = np.linalg.norm(V - vp[None, :, :], axis=2)
        with np.errstate(invalid="ignore"):
            inner = D[:, 1:-1]
            mask = (inner < D[:, :-2]) & (inner < D[:, 2:]) & (inner < screening_radius_km + 0.5 * coarse_step_s * np.minimum(S[:, 1:-1], max_rel_speed_kms))
        for c, o in enumerate(objs):
            k = start + c
            res = results[o.object_id]
            if res.status == "FAILED" or np.isnan(D[c]).all():
                status[k] = STATUS_FAILED
                continue
            valid = ~np.isnan(D[c])
            i_min = int(np.nanargmin(D[c]))
            d_min[k] = float(D[c, i_min])
            tca[k] = float(times[i_min])
            speed_at[k] = float(S[c, i_min])
            if np.nanmax(S[c][valid]) < co_orbital_min_speed_kms and d_min[k] < screening_radius_km:
                status[k] = STATUS_CO_ORBITAL
                continue
            flagged = np.nonzero(mask[c])[0] + 1
            n_minima[k] = len(flagged)
            if len(flagged) == 0:
                continue
            tf = np.unique(np.concatenate([times[i] + fine_offsets for i in flagged]))
            tf = tf[(tf >= times[0]) & (tf <= times[-1])]
            fp = propagate(primary, tf)
            fs = propagate(o, tf)
            df = np.linalg.norm(fs.positions_km - fp.positions_km, axis=1)
            if np.isnan(df).all():
                continue
            j = int(np.nanargmin(df))
            t_star, d_star = _parabolic_min(tf, df * df, j)
            if d_star < d_min[k]:
                d_min[k] = d_star
                tca[k] = t_star
                speed_at[k] = float(np.linalg.norm(fs.velocities_kms[j] - fp.velocities_kms[j]))
    return PairLabels(d_min, tca, speed_at, status, n_minima)


# --------------------------------------------------------------------------
# dataset assembly (optionally multi-process)
# --------------------------------------------------------------------------

_WORKER_OBJECTS: List[OrbitalObject] = []


def _worker_init(tle_text: str) -> None:
    global _WORKER_OBJECTS
    objs, _ = parse_tle_text(tle_text, source="celestrak", source_detail="training")
    _WORKER_OBJECTS = objs


def _catalog_text(objects: Sequence[OrbitalObject]) -> str:
    lines = []
    for o in objects:
        if o.tle_line1 and o.tle_line2:
            lines += [o.name, o.tle_line1, o.tle_line2]
    return "\n".join(lines) + "\n"


def _label_primary(args: Dict[str, Any]) -> Dict[str, Any]:
    objs = _WORKER_OBJECTS if _WORKER_OBJECTS else args["objects"]
    by_norad = {o.norad_id: o for o in objs}
    primary = by_norad[args["primary_norad"]]
    rng = np.random.default_rng(args["seed"] + int(args["primary_norad"]))
    cands = candidate_pool(primary, [o for o in objs if o.norad_id != primary.norad_id], args["band_margin_km"],
                           args["max_candidates"], rng)
    t_start = float(int(primary.epoch_unix // 3600) * 3600)
    fm = pair_features(primary, cands, t_start)
    labels = label_pairs(primary, cands, t_start, args["horizon_s"], args["coarse_step_s"],
                         screening_radius_km=args["label_radius_km"])
    keep = fm.ok_mask & (labels.status == STATUS_OK) & np.isfinite(labels.d_min_km)
    return {"primary_id": primary.object_id, "X": fm.X[keep].astype(np.float32), "d_min": labels.d_min_km[keep],
            "tca": labels.tca_unix[keep], "speed": labels.rel_speed_kms[keep],
            "secondary_ids": [c.object_id for c, k in zip(cands, keep) if k],
            "n_candidates": len(cands), "n_failed": int((labels.status == STATUS_FAILED).sum()),
            "n_co_orbital": int((labels.status == STATUS_CO_ORBITAL).sum())}


def build_dataset(objects: Sequence[OrbitalObject], primaries: Sequence[OrbitalObject], *, band_margin_km: float = 150.0,
                  max_candidates: int = 3000, horizon_s: float = 86400.0, coarse_step_s: float = 30.0,
                  label_radius_km: float = 25.0, seed: int = 0, workers: int = 1,
                  progress: Optional[Any] = None, meta: Optional[Dict[str, Any]] = None) -> Dataset:
    args = [{"primary_norad": p.norad_id, "seed": seed, "band_margin_km": band_margin_km, "max_candidates": max_candidates,
             "horizon_s": horizon_s, "coarse_step_s": coarse_step_s, "label_radius_km": label_radius_km} for p in primaries]
    t0 = time.time()
    results: List[Dict[str, Any]] = []
    if workers > 1:
        text = _catalog_text(objects)
        with ProcessPoolExecutor(max_workers=workers, initializer=_worker_init, initargs=(text,)) as ex:
            for i, r in enumerate(ex.map(_label_primary, args)):
                results.append(r)
                if progress:
                    progress(i + 1, len(args), r)
    else:
        for i, a in enumerate(args):
            a = dict(a, objects=list(objects))
            r = _label_primary(a)
            results.append(r)
            if progress:
                progress(i + 1, len(args), r)
    X = np.concatenate([r["X"] for r in results]) if results else np.zeros((0, len(FEATURE_NAMES)), np.float32)
    d = np.concatenate([r["d_min"] for r in results]) if results else np.zeros(0)
    tca = np.concatenate([r["tca"] for r in results]) if results else np.zeros(0)
    sp = np.concatenate([r["speed"] for r in results]) if results else np.zeros(0)
    group = np.concatenate([np.full(len(r["d_min"]), i) for i, r in enumerate(results)]) if results else np.zeros(0, int)
    sec = [s for r in results for s in r["secondary_ids"]]
    info = dict(meta or {})
    info.update({"built_at": iso(datetime.now(timezone.utc)), "n_primaries": len(results), "rows": int(len(d)),
                 "band_margin_km": band_margin_km, "max_candidates": max_candidates, "horizon_s": horizon_s,
                 "coarse_step_s": coarse_step_s, "label_radius_km": label_radius_km, "seed": seed,
                 "duration_s": round(time.time() - t0, 1),
                 "failed_pairs": int(sum(r["n_failed"] for r in results)),
                 "co_orbital_pairs": int(sum(r["n_co_orbital"] for r in results))})
    return Dataset(X, d, tca, sp, group.astype(int), [r["primary_id"] for r in results], sec, info)
