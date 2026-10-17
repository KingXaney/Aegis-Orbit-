---
title: Conjunction, TCA and miss distance
type: concept
tags: [screening, geometry]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Conjunction, TCA and miss distance

A conjunction is a predicted close approach between two orbiting objects. It is described by the time
of closest approach (TCA), the miss distance at that time and the relative speed.

## Definition

- **Primary / secondary.** The primary is the protected asset (AEGIS-1, the ISS). The secondary is the
  other object. Relative vectors are always *secondary minus primary*
  ([screening.py:45](../../../backend/app/physics/screening.py#L45)).
- **Conjunction.** A local minimum of the separation |r_s(t) − r_p(t)| that falls below the
  **screening radius**.
- **TCA.** The time of that minimum. **Miss distance** is the separation at TCA, and **relative speed**
  is |v_s − v_p| at TCA.

## Why it matters

Screening by distance is cheap. It decides which encounters receive the expensive work:
[collision probability](collision-probability.md), [maneuver planning](avoidance-maneuvers.md) and
[secondary screening](secondary-screening.md).

LEO crossing encounters are fast, around 7–15 km/s. At 7.7 km/s, a 30 s sampling step moves the pair
about 230 km relative to each other, so the true minimum hides between samples. Screening therefore
widens its threshold by half a step of relative motion and then refines each minimum numerically
([screening.py:257-259](../../../backend/app/physics/screening.py#L257-L259)). Before that, any pair
whose minimum coarse separation exceeds the radius plus two steps at 16 km/s ("max LEO relative
speed") is skipped outright ([screening.py:244](../../../backend/app/physics/screening.py#L244)).

## In Aegis Orbit

- **Screening radius:** 25 km, a demo setting
  ([config.py:37](../../../backend/app/config.py#L37)).
- **Co-orbital pairs are not conjunctions.** If the relative speed stays below 0.01 km/s, the pair is
  treated as docked or flying in formation and excluded
  ([config.py:40](../../../backend/app/config.py#L40)). An example is PROGRESS-MS 34 docked to the ISS
  ([baseline run](../analyses/2026-10-17-baseline-pipeline-run.md#real-scenario-real-iss)).
- **IDs** look like `CJ-<primary>-<secondary>-<round(tca_unix)>`, with `NORAD-` stripped
  ([screening.py:208-211](../../../backend/app/physics/screening.py#L208-L211)), for example
  `CJ-25544-43099-1792273884`.
- **Ranking** is by miss distance, then by TCA
  ([screening.py:299-301](../../../backend/app/physics/screening.py#L299-L301)).
- **One pair can produce many conjunctions.** Two orbits at the same altitude meet near both
  intersection nodes, so the encounters repeat about every half period. The synthetic debris appears
  7 times in 6 hours. Only the encounter at the designed TCA is critical
  ([baseline run](../analyses/2026-10-17-baseline-pipeline-run.md#synthetic-scenario-synthetic-conjunction)).

The full pipeline is described in [screening pipeline](../components/screening-pipeline.md).

## Pitfalls

- **Miss distance is not risk.** A 350 m miss can be critical or harmless depending on the position
  uncertainty; see [collision probability](collision-probability.md).
- **Instantaneous altitude is the wrong prefilter.** An eccentric orbit crosses many altitudes, so
  the filter compares perigee/apogee bands instead
  ([screening.py:116-132](../../../backend/app/physics/screening.py#L116-L132)).
- **Two minima can merge.** A minimum narrower than the coarse step that sits right next to another
  minimum can be merged with it. This limitation is documented in
  [screening.py:18-21](../../../backend/app/physics/screening.py#L18-L21).

## See also

[Screening pipeline](../components/screening-pipeline.md) ·
[Collision probability](collision-probability.md) · [Threat states](threat-states.md)
