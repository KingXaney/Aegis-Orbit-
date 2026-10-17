---
title: Synthetic conjunction scenario
type: scenario
tags: [scenario, synthetic, demo]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Synthetic conjunction scenario

`synthetic-conjunction` is the scripted demo. The primary AEGIS-1, on a 420 km orbit, meets debris
DEB-2047 at 354 m and 7.7 km/s exactly three hours into a six-hour window. Every reset rebuilds the
encounter identically.

## Setup

Built deterministically, with no randomness ([synthetic.py:1-19](../../../backend/app/scenarios/synthetic.py#L1-L19)):

1. **The primary, `SYN-AEGIS-1`.** It starts on a circular orbit at 420 km altitude, 51.6° inclination,
   RAAN 40° and argument of latitude 15°, at T0 = 2026-10-17T00:00:00Z. It is propagated with two-body
   + J2 to the designed TCA, T0 + 3 h, where its state is P\*
   ([synthetic.py:33-47](../../../backend/app/scenarios/synthetic.py#L33-L47)).
2. **The secondary, `SYN-DEB-2047`, is defined at the TCA.**
   - Position: P\* plus a designed miss of 0.35 km horizontal (perpendicular to the relative velocity)
     and 0.05 km radial.
   - Velocity: the primary's velocity direction rotated **60° about the local radial axis**, at
     circular speed ([synthetic.py:82-91](../../../backend/app/scenarios/synthetic.py#L82-L91)).
3. **The secondary is back-propagated** to T0 with the same model. Forward propagation therefore
   reproduces the encounter up to integrator error
   ([synthetic.py:93-94](../../../backend/app/scenarios/synthetic.py#L93-L94)).
4. **Five background objects** at other altitudes and planes. They carry no covariance and are
   non-threatening by design ([synthetic.py:102-108](../../../backend/app/scenarios/synthetic.py#L102-L108)):

| ID | Name | Category | Alt (km) | Inc (°) | Radius (m) |
|---|---|---|---|---|---|
| SYN-SAT-A | ORBITER-A | payload | 545 | 97.6 | 3.0 |
| SYN-RB-7 | UPPER STAGE R/B | rocket body | 610 | 63.4 | 4.0 |
| SYN-DEB-311 | FRAGMENT-311 | debris | 480 | 86.4 | 0.5 |
| SYN-SAT-C | RELAY-C | payload | 400 | 28.5 | 2.0 |
| SYN-DEB-902 | FRAGMENT-902 | debris | 470 | 51.6 | 0.5 |

**Uncertainty, labelled as scenario definitions.**

| Object | Radius | 1σ RTN covariance |
|---|---|---|
| AEGIS-1 | 7.5 m | 60/200/60 m |
| DEB-2047 | 2.5 m | 120/250/120 m |

Both covariances are labelled `ASSUMED_ILLUSTRATIVE`
([synthetic.py:96-99](../../../backend/app/scenarios/synthetic.py#L96-L99)). The scenario uses the
`provided_only` policy and highlights DEB-2047 in the UI
([registry.py:52-70](../../../backend/app/scenarios/registry.py#L52-L70)).

## What happens

Measured in the [baseline run](../analyses/2026-10-17-baseline-pipeline-run.md#synthetic-scenario-synthetic-conjunction):

1. **Screening finds 7 conjunctions, all with DEB-2047.** The two orbits share an altitude and cross at
   60°, so the objects pass near both intersection nodes about every half period (≈ 46.5 min). Only
   the designed pass is close: 0.353547 km at exactly T0 + 10 800.000 s, 6 mm from the designed
   0.353553 km. That pass has Pc 5.74e-4 and is **CRITICAL**. The other six (6–23 km) are MONITORING.
2. **The planner** evaluates 120 burns and recommends:
   - **MV-DEB-2047-066:** −T (retrograde) 0.05 m/s at 1.5 orbits before TCA, burning at 00:40:32.666Z.
     The miss becomes 1.458 km and Pc 9.1e-10.
   - **The alternatives:** +T 0.10 m/s (1.856 km) and −R 0.35 m/s at 0.5 orbits (1.425 km).
3. **Secondary screening** returns PASS for all three.
4. **Approval** sets the session to **MITIGATED**.
5. **Reset** restores the identical initial state.

## Why a retrograde burn beats a prograde one

The two velocities are equal in magnitude and 60° apart, so the relative velocity forms an equilateral
triangle with them. It points 120° from the primary's along-track direction. An along-track
displacement Δy therefore lands in the encounter plane as 0.866·Δy, *along the same horizontal axis as
the designed 0.35 km miss*. The displacement's sign decides whether it opens or closes the gap.

Linear relative motion predicts the displacement *(background)*. An along-track burn Δv held for time
t gives an along-track shift of 3·Δv·t and a radial shift of 4Δv/n at odd half-orbits. A radial burn
gives an along-track shift of 4Δv/n at odd half-orbits. Here n = 2π/5 578.2 s and t is 2 789 s at
0.5 orbits or 8 367 s at 1.5 orbits. Adding that shift to the designed miss
(horizontal 0.35, radial 0.05 km) gives:

| Candidate | Predicted in-plane miss (horiz, radial) km | Predicted | Measured |
|---|---|---|---|
| −T 0.05 m/s @ 1.5 orb | (0.35 + 1.087, 0.05 + 0.178) | 1.455 km | 1.458 km |
| +T 0.05 m/s @ 1.5 orb | (0.35 − 1.087, 0.05 − 0.178) | 0.748 km | 0.751 km |
| −T 0.05 m/s @ 0.5 orb | (0.35 + 0.362, 0.05 + 0.178) | 0.748 km | 0.749 km |
| +T 0.05 m/s @ 0.5 orb | (0.35 − 0.362, 0.05 − 0.178) | 0.128 km | 0.128 km |
| −R 0.35 m/s @ 0.5 orb | (0.35 + 1.076, 0.05) | 1.427 km | 1.425 km |
| −R 0.35 m/s @ 1.0 orb | (0.35, 0.05) | 0.354 km | 0.356 km |

The linear model reproduces the planner's numerically propagated results to within 3 m. The prograde
burn first has to cancel the existing miss before it can grow a new one, so it needs twice the Δv to
pass the target. The worst grid point, **+T 0.05 m/s at 0.5 orbits, makes the encounter more
dangerous**: 128 m and Pc 8.3e-4.

This is the scenario's version of the general rule in
[avoidance maneuvers](../concepts/avoidance-maneuvers.md#why-direction-and-lead-time-matter).

## See also

[Maneuver planner](../components/maneuver-planner.md) · [Collision probability](../concepts/collision-probability.md) ·
[Real ISS scenario](real-iss.md)
