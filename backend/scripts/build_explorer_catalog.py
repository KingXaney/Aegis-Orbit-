"""Build the committed explorer catalog fixture from CelesTrak.

Usage:
    python scripts/build_explorer_catalog.py [--output ../data/catalog/explorer_catalog.json.gz] [--force]

Downloads GROUP=active, NAME=DEB, NAME=R/B and SATCAT (reusing data/cache
copies younger than two hours unless --force), joins them on NORAD ID and
writes gzipped JSON rows that the API serves when no fresher cache exists.
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.data import explorer_catalog  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", default=str(explorer_catalog.FIXTURE_PATH))
    ap.add_argument("--force", action="store_true", help="re-download even if the cache is fresh")
    args = ap.parse_args()

    rows, meta = explorer_catalog.download_rows(force=args.force)
    explorer_catalog.write_rows(Path(args.output), rows, meta)
    objects, rejected = explorer_catalog.catalog_objects(rows)
    print(f"wrote {len(rows)} rows to {args.output} ({rejected} rejected on validation)")
    print("stats:", meta["stats"])
    print("types:", dict(Counter(o["type"] for o in objects)))
    print("orbit classes:", dict(Counter(o["orbit_class"] for o in objects)))


if __name__ == "__main__":
    main()
