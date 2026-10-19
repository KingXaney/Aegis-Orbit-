---
title: Data layer
type: component
tags: [data, backend]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Data layer

`backend/app/data/` turns CelesTrak element sets into validated `OrbitalObject`s. Each object carries
its provenance, its propagation model and labelled uncertainty. The real scenario runs offline from a
committed fixture, and network refresh is optional.

## Pieces

| File | Role |
|---|---|
| [catalog.py](../../../backend/app/data/catalog.py) | `OrbitalObject` dataclass and `Catalog` (ordered dict + rejected records + `source_info`) |
| [tle.py](../../../backend/app/data/tle.py) | TLE validation, parsing, derived elements, category inference, STALE flagging |
| [celestrak.py](../../../backend/app/data/celestrak.py) | GP download (`gp.php?GROUP=…&FORMAT=tle`) and a cache with sidecar metadata |
| [scripts/build_real_fixture.py](../../../backend/scripts/build_real_fixture.py) | rebuilds `backend/data/scenarios/real_catalog.{tle,meta.json}` from downloaded groups |

## OrbitalObject

One record describes one object, whichever model propagates it
([catalog.py:22-51](../../../backend/app/data/catalog.py#L22-L51)):

- **identity:** `object_id` (`NORAD-<n>` or `SYN-…`), `name`, `category` + `category_basis`,
  `norad_id`, `intl_designator`
- **provenance:** `source`, `source_detail`, `epoch` and `retrieved_at`
- **model:** `propagation_model` (`SGP4` | `NUMERICAL_J2`) with either a `satrec` and the TLE lines,
  or an initial TEME state at `state_epoch_unix`
- **uncertainty:** `radius_m` + `radius_basis`, and `covariance_rtn_m2` + `covariance_source`
- **derived:** perigee and apogee altitude, period and inclination, which the band filter and the
  planner use
- **health:** `validation_status` (OK/STALE/INVALID) and free-text `warnings`

See [basis labels](../concepts/covariance-and-basis-labels.md) for what each label means.

## Cache and network

- **Cache files.** Each downloaded group is written to `backend/data/cache/celestrak_<group>.tle`, with a
  `.meta.json` sidecar recording the group, the URL, `retrieved_at` and the line count
  ([celestrak.py:25-57](../../../backend/app/data/celestrak.py#L25-L57)). The cache directory is
  git-ignored.
- **Network gate.** `ALLOW_NETWORK=false` blocks every download with `DataUnavailable`, which the API
  maps to HTTP 503 ([celestrak.py:30-43](../../../backend/app/data/celestrak.py#L30-L43)).
- **Live rebuild.** `POST /api/data/refresh` downloads all five groups and rebuilds `real-iss`
  ([routes.py:164-174](../../../backend/app/api/routes.py#L164-L174)).

## Fixture vs live catalog

The fixture builder and `real.build_live_catalog()` apply the same selection:

1. keep the primary
2. drop co-located ISS entries
3. keep objects whose band, widened by 60 km, overlaps the ISS band
4. sort by the distance between band centres and cap the list at 400
   ([build_real_fixture.py:46-60](../../../backend/scripts/build_real_fixture.py#L46-L60),
   [real.py:58-89](../../../backend/app/scenarios/real.py#L58-L89))

The current fixture's numbers are in [GP elements and TLEs](../concepts/gp-elements-and-tle.md#in-aegis-orbit).

## Invariants and gotchas

- **Rejections are never silent.** Rejected records are kept with a reason (checksum, short line,
  unpaired, SGP4 error at epoch), and `GET /api/objects` returns up to 50 of them
  ([service.py:51-57](../../../backend/app/simulation/service.py#L51-L57)).
- **The two builders exclude ISS entries slightly differently.** The fixture builder drops names that
  start with `ISS (` and an explicit set {`ISS (NAUKA)`, `POISK`, `ISS (ZVEZDA)`, `ISS DEB`}. The live
  builder drops `ISS (…` and `POISK` only
  ([build_real_fixture.py:24](../../../backend/scripts/build_real_fixture.py#L24),
  [real.py:77](../../../backend/app/scenarios/real.py#L77)). An object named exactly `ISS DEB` would be
  excluded from the fixture but kept in a live refresh. The current fixture has no such object.
- **Docked vehicles are not excluded at build time.** Visiting vehicles such as Progress and Soyuz share
  the station's elements but keep their own names, so they stay in the catalog. Screening classifies
  them as [co-orbital](../concepts/conjunction.md#in-aegis-orbit) instead.

## Tests

[test_tle.py](../../../backend/tests/test_tle.py) covers:

- a valid TLE parses with its provenance
- checksum mismatches, unpaired lines and short lines are rejected
- the 2-line format without a name parses
- categories are inferred from names
- sub-orbital records are rejected
- stale records are flagged

## See also

[GP elements and TLEs](../concepts/gp-elements-and-tle.md) · [Real ISS scenario](../scenarios/real-iss.md)
