---
title: GP elements and TLEs
type: concept
tags: [data, orbital-elements]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# GP elements and TLEs

GP (general perturbations) element sets are mean orbital elements that a data provider fits for each
cataloged object and publishes in the two-line element (TLE) format. Positions derived from them are
SGP4 estimates, not sensor telemetry.

## Definition

A TLE holds an epoch, mean motion, eccentricity, inclination, RAAN, argument of perigee, mean anomaly
and a drag term (B*). The values are *mean* elements in SGP4's theory, so they are only meaningful
when fed to SGP4 *(background)*. The only provenance a TLE carries is its epoch. It has no
uncertainty, which is why Pc from public data is `UNVERIFIED`
([tle.py:1-6](../../../backend/app/data/tle.py#L1-L6); see [basis labels](covariance-and-basis-labels.md)).

## In Aegis Orbit

- **Validation before use** ([tle.py:39-52](../../../backend/app/data/tle.py#L39-L52)):
  - each line is 69 characters and starts with `1` or `2`
  - the mod-10 checksum matches; digits count at face value and `-` counts as 1
    ([tle.py:29-36](../../../backend/app/data/tle.py#L29-L36))
  - both lines carry the same catalog number

  A record is also evaluated with SGP4 at its epoch, and any SGP4 error rejects it, for example
  "sub-orbital" or "decayed" ([tle.py:82-86](../../../backend/app/data/tle.py#L82-L86)).
- **Formats.** Both 2-line and 3-line (named) sets parse. Unpaired element lines are rejected with a
  reason ([tle.py:120-146](../../../backend/app/data/tle.py#L120-L146)).
- **Derived fields.** Semi-major axis comes from the Kozai mean motion. Perigee and apogee altitude and
  the period follow from it, and a perigee below 80 km triggers a near-re-entry warning
  ([tle.py:88-116](../../../backend/app/data/tle.py#L88-L116)).
- **Category is guessed from the name.** `DEB`/`DEBRIS` maps to debris, `R/B`/`ROCKET` to rocket body
  and anything else to payload. The guess is labelled `INFERRED_FROM_NAME`
  ([tle.py:55-61](../../../backend/app/data/tle.py#L55-L61)).
- **Staleness.** A record more than 30 days older than the scenario window is flagged `STALE` with a
  warning ([config.py:33](../../../backend/app/config.py#L33),
  [tle.py:149-158](../../../backend/app/data/tle.py#L149-L158)).
- **Source.** [CelesTrak](https://celestrak.org/) GP endpoint, groups `stations`, `active`,
  `cosmos-2251-debris`, `iridium-33-debris` and `fengyun-1c-debris`
  ([real.py:27](../../../backend/app/scenarios/real.py#L27)). The three debris groups are the remains of
  the 2009 Iridium 33 / Cosmos 2251 collision and the 2007 Fengyun-1C anti-satellite test
  *(background)*.
- **Committed fixture.** Retrieved 2026-10-17T15:59:10Z. It parsed 18,604 records, with 0 rejected.
  10,853 objects overlapped the ISS band ±60 km, capped to the 400 closest by band centre. Five ISS
  module entries were excluded as co-located
  ([real_catalog.meta.json](../../../backend/data/scenarios/real_catalog.meta.json)).

See [data layer](../components/data-layer.md) for the cache, fixture builder and live refresh.

## Pitfalls

- **Accuracy ages.** It degrades with distance from the epoch, to km level after a day. The real
  scenario anchors its window at the ISS epoch for this reason
  ([real.py:92-97](../../../backend/app/scenarios/real.py#L92-L97)).
- **One physical object can have several catalog entries.** Docked vehicles share the station's
  elements, and ISS modules can appear separately. They must be excluded or treated as co-orbital,
  never reported as conjunctions.

## See also

[Propagation models](propagation-models.md) · [Data layer](../components/data-layer.md) ·
[Real ISS scenario](../scenarios/real-iss.md)
