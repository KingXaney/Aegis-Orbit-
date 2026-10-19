---
title: Real ISS scenario
type: scenario
tags: [scenario, real-data, iss]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Real ISS scenario

`real-iss` screens the ISS (NORAD 25544) for 24 hours against 399 cataloged objects from public
CelesTrak elements. Nothing is fabricated: no covariance exists, so every probability is `UNVERIFIED`
and the scenario reports whatever the screening finds.

## Setup

- **Catalog.** The committed fixture `backend/data/scenarios/real_catalog.tle` holds 400 objects: the ISS plus
  the 399 objects closest to its band among the 10,853 whose band, widened by 60 km, overlapped. They
  come from the CelesTrak groups `stations`, `active` and three debris groups, retrieved
  2026-10-17T15:59:10Z ([real_catalog.meta.json](../../../backend/data/scenarios/real_catalog.meta.json)). See
  [data layer](../components/data-layer.md#fixture-vs-live-catalog).
- **Window.** 24 h starting at the ISS element epoch rounded down to the hour, so SGP4 is evaluated
  close to its epoch ([real.py:92-97](../../../backend/app/scenarios/real.py#L92-L97)). For this fixture
  that is 2026-10-17T04:00Z to 2026-10-18T04:00Z.
- **Hard-body radius.** The ISS is overridden to 55 m, an approximate envelope radius labelled
  `SCENARIO_DEFINITION` ([real.py:31-40](../../../backend/app/scenarios/real.py#L31-L40)). Every other
  object uses its category default.
- **Policy.** `provided_only`, so Pc is `UNVERIFIED`. The optional `illustrative_default` re-screen is
  labelled as illustrative wherever it appears.
- **Rendering.** The globe shows the ISS plus the 80 objects closest in band
  ([registry.py:78-82](../../../backend/app/scenarios/registry.py#L78-L82)).
- **Disclaimers.** They give the retrieval time and state that "No conjunction is forced in this
  scenario" ([registry.py:97-100](../../../backend/app/scenarios/registry.py#L97-L100)).

## What happens

Measured in the [baseline run](../analyses/2026-10-17-baseline-pipeline-run.md#real-scenario-real-iss):

- **12 conjunctions** fall inside 25 km, between 6.7 and 24.8 km, at relative speeds of 2.5–12.7 km/s.
- **The closest is SUPERVIEW-1 03** at 6.711 km, 2026-10-17T21:51:24Z. It is under 10 km with no
  covariance, so it is **UNVERIFIED**, and that sets the session's overall state. The other 11 are
  MONITORING.
- **Three objects produce two passes each:** STARLINK-2469, ENSHI XIDA SHANQUAN and 2024-199AK.
- **PROGRESS-MS 34**, docked to the station, is excluded as co-orbital.

## Numbers

- **The altitude filter passes 399 of 399.** The fixture was already band-filtered at ±60 km, wider
  than the screening filter's ±50 km
  ([config.py:39](../../../backend/app/config.py#L39)), so screening's own filter removes nothing here.
- **Screening took 0.37 s:** 2 881 samples at 30 s with batched SGP4, and 96 minima refined.
- **No records were STALE:** every element epoch lies within 30 days of the window start
  ([config.py:33](../../../backend/app/config.py#L33)).

## Caveats

- **Results are tied to this fixture.** A live refresh (`POST /api/scenarios/real-iss/reset?live=true`
  or `POST /api/data/refresh`) changes the window and the objects, and therefore every number above.
- **SGP4 error grows from each object's own epoch.** Kilometre-level position errors are normal a day
  out, so a 6.7 km SGP4 miss distance can't be told apart from a much closer, or much wider, pass
  *(background)*. That is the point of the `UNVERIFIED` label.
- **Planning here would use the distance target.** Without Pc, the target is miss ≥ 5 km, and
  SUPERVIEW-1 03 already sits above it. The planner hasn't been run on this scenario yet; see
  [open questions](../analyses/open-questions.md).

## See also

[GP elements and TLEs](../concepts/gp-elements-and-tle.md) ·
[Basis labels](../concepts/covariance-and-basis-labels.md) · [Synthetic scenario](synthetic-conjunction.md)
