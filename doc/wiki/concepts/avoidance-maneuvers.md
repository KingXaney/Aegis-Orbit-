---
title: Avoidance maneuvers
type: concept
tags: [maneuver, physics, relative-motion]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Avoidance maneuvers

An avoidance maneuver is a small velocity change made some time before TCA, so that the primary
arrives at the encounter displaced. The direction and the lead time matter more than the size of
the burn.

## Definition

Aegis Orbit models **impulsive** burns: an instantaneous Δv applied at the burn time, specified in
the local [RTN frame](reference-frames.md#rtn-local-orbital-frame). The parameters are:

- **direction**: ±R (radial), ±T (along-track; +T is prograde), ±N (cross-track)
- **magnitude**: 0.05–0.5 m/s on the default grid ([config.py:51](../../../backend/app/config.py#L51))
- **lead time**: how long before TCA the burn happens, measured in orbital periods (0.5–2.0)
  ([config.py:50](../../../backend/app/config.py#L50))

## Why direction and lead time matter

To first order, linearised relative motion (Clohessy–Wiltshire / Hill) says how a small Δv displaces
an object after time t, where n is the mean motion. All three results are *(background)*:

| Burn | Along-track offset after t | Behaviour |
|---|---|---|
| along-track (T) | ≈ −3·Δv·t + (4Δv/n)·sin(nt) | **grows without bound**: the burn changes the period, so the object drifts |
| radial (R) | (2Δv/n)(cos nt − 1) | bounded; −4Δv/n at half-orbit, **zero at every whole orbit** |
| cross-track (N) | 0 (out-of-plane (Δv/n)·sin nt) | bounded; **zero at every half orbit** |

Three consequences, all visible in the measured planner grid
([baseline run](../analyses/2026-10-17-baseline-pipeline-run.md#synthetic-scenario-synthetic-conjunction)):

1. **Along-track burns are the cheapest, and earlier is better.**
   - At 1.5 orbits (8 367 s), −T 0.05 m/s moves the miss from 0.354 km to 1.458 km.
   - The predicted along-track shift is 3 × 0.05 × 8 367 ≈ 1.25 km. About 87 % of that lies in the
     encounter plane, which accounts for the change.
   - The test suite uses the same rule of thumb: "~3·dv·dt along-track displacement"
     ([test_planner.py:31-37](../../../backend/tests/test_planner.py#L31-L37)).
2. **A radial burn works only at odd half-orbit leads.**
   - −R 0.35 m/s gives 1.425 km at 0.5 orbits and 1.423 km at 1.5 orbits. At 1.0 orbit it leaves the
     miss unchanged at 0.356 km.
   - The prediction is 4Δv/n ≈ 4 × 0.35 / 1.126e-3 s⁻¹ ≈ 1.24 km.
3. **Cross-track burns never help on this grid.** Every lead is a multiple of half an orbit, which is
   exactly where an N-burn's displacement passes back through zero. All ±N candidates leave the miss
   at 0.346–0.361 km.

These are linear predictions on a near-circular orbit. The planner itself doesn't use them: it
propagates every candidate numerically. They explain the planner's results; they don't replace it.

## In Aegis Orbit

The [maneuver planner](../components/maneuver-planner.md) grid-searches 4 leads × 6 directions × 5
magnitudes. It scores each candidate with J = Δv/budget + risk shortfall (+1000 if infeasible), and
recommends a diverse top 3. Every recommendation then needs
[secondary screening](secondary-screening.md) and a human decision.

## Pitfalls

- **The wrong sign can make things worse.**
  - +T 0.05 m/s at 0.5 orbits *shrinks* the synthetic miss from 354 m to 128 m and *raises* Pc to
    8.3e-4.
  - The displacement adds vectorially to the existing miss. Depending on the sign, it opens or closes
    the gap ([synthetic scenario](../scenarios/synthetic-conjunction.md#why-a-retrograde-burn-beats-a-prograde-one)).
- **The model leaves things out.** Execution errors, covariance growth and drag on the post-burn arc
  are not modelled ([maneuver_planner.py:63-69](../../../backend/app/physics/maneuver_planner.py#L63-L69)).
- **Clearing one object is not safety.** A burn that clears the threat can create a new approach with
  something else.

## See also

[Maneuver planner](../components/maneuver-planner.md) · [Secondary screening](secondary-screening.md) ·
[Reference frames](reference-frames.md)
