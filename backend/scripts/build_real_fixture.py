"""Build the committed real-data fixture from downloaded CelesTrak group files.

Usage:
    python scripts/build_real_fixture.py --source-dir <dir with *.tle + retrieved_at.txt> \
        --output ../data/scenarios/real_catalog.tle [--primary 25544] [--margin-km 60] [--max-objects 400]

The fixture keeps the primary plus every object whose perigee/apogee band
(widened by the margin) overlaps the primary's band, capped at --max-objects
closest in altitude. ISS modules tracked as separate catalog entries are
excluded because they are the same physical object as the primary.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.data.tle import parse_tle_text  # noqa: E402

ISS_MODULE_EXCLUSIONS = {"ISS (NAUKA)", "POISK", "ISS (ZVEZDA)", "ISS DEB"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-dir", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--primary", type=int, default=25544)
    ap.add_argument("--margin-km", type=float, default=60.0)
    ap.add_argument("--max-objects", type=int, default=400)
    args = ap.parse_args()

    src = Path(args.source_dir)
    retrieved_at = (src / "retrieved_at.txt").read_text().strip()
    groups = sorted(p.stem for p in src.glob("*.tle"))
    by_norad = {}
    rejected = []
    for g in groups:
        objs, rej = parse_tle_text((src / f"{g}.tle").read_text(), source_detail=f"GROUP={g}")
        rejected.extend(rej)
        for o in objs:
            by_norad.setdefault(o.norad_id, (o, g))
    primary, pgroup = by_norad[args.primary]
    p_lo, p_hi = primary.perigee_alt_km, primary.apogee_alt_km
    selected = []
    excluded = []
    for norad, (o, g) in by_norad.items():
        if norad == args.primary:
            continue
        if o.name.strip() in ISS_MODULE_EXCLUSIONS or (o.name.startswith("ISS (") and norad != args.primary):
            excluded.append({"norad_id": norad, "name": o.name.strip(), "reason": "ISS module/co-located entry"})
            continue
        if o.perigee_alt_km - args.margin_km <= p_hi and o.apogee_alt_km + args.margin_km >= p_lo:
            center = 0.5 * (o.perigee_alt_km + o.apogee_alt_km)
            selected.append((abs(center - 0.5 * (p_lo + p_hi)), o, g))
    selected.sort(key=lambda t: (t[0], t[1].norad_id))
    kept = selected[: args.max_objects - 1]
    out_lines = []
    for o, g in [(primary, pgroup)] + [(o, g) for _, o, g in kept]:
        out_lines += [o.name.ljust(24), o.tle_line1, o.tle_line2]
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(out_lines) + "\n")
    meta = {
        "source": "CelesTrak GP data (https://celestrak.org/NORAD/elements/)",
        "groups": groups,
        "retrieved_at": retrieved_at,
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "primary_norad_id": args.primary,
        "primary_name": primary.name.strip(),
        "filter": {
            "rule": "perigee/apogee band of the object, widened by margin_km, overlaps the primary's band",
            "margin_km": args.margin_km,
            "candidates_matching": len(selected),
            "max_objects": args.max_objects,
        },
        "object_count": 1 + len(kept),
        "records_parsed": len(by_norad),
        "records_rejected": len(rejected),
        "excluded": excluded,
        "note": "Mean elements fitted by the data provider; positions derived from them are SGP4 estimates, "
                "not live telemetry. Accuracy degrades with age from each record's epoch.",
    }
    out.with_suffix(".meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote {out} with {meta['object_count']} objects ({len(selected)} matched, "
          f"{len(rejected)} rejected, {len(excluded)} excluded)")


if __name__ == "__main__":
    main()
