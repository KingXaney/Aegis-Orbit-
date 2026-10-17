---
title: Maneuver planner
type: component
tags: [maneuver, physics, backend]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Maneuver planner

`physics/maneuver_planner.plan_maneuvers()` grid-searches impulsive RTN burns for one conjunction. It
re-computes each candidate's closest approach and Pc, rejects infeasible candidates, ranks the rest by
a documented objective and recommends a diverse top 3.

## How it works

The main loop is in [maneuver_planner.py:209-322](../../../backend/app/physics/maneuver_planner.py#L209-L322).

1. **The secondary near TCA** is propagated once on a dense grid, TCA ± 180 s at 2 s steps, using its
   own model ([maneuver_planner.py:224-229](../../../backend/app/physics/maneuver_planner.py#L224-L229)).
2. **For each lead time** in {0.5, 1.0, 1.5, 2.0} orbits (the period falls back to 5 600 s if
   unknown):
   - The burn time is t_b = TCA − lead × period.
   - Feasibility reasons are collected: the burn falls before the earliest allowed time, or the lead
     time is under 1 800 s
     ([maneuver_planner.py:234-241](../../../backend/app/physics/maneuver_planner.py#L234-L241)).
   - The primary's state at t_b comes from its *native* model.
3. **Candidates.** Each direction in {±T, ±R, ±N} is combined with each magnitude in
   {0.05, 0.1, 0.2, 0.35, 0.5} m/s, plus a zero-Δv baseline. The Δv is rotated from RTN to TEME. All
   candidate states are then propagated *together* with the J2 model onto the dense grid
   ([maneuver_planner.py:247-258](../../../backend/app/physics/maneuver_planner.py#L247-L258)).
4. **Per candidate:**
   - Take the argmin on the grid, then refine it with bounded minimisation
     ([maneuver_planner.py:187-206](../../../backend/app/physics/maneuver_planner.py#L187-L206)).
   - Compute Pc, assuming the covariance is unchanged by the burn.
   - Assign the threat state and the target verdict
     ([maneuver_planner.py:276-281](../../../backend/app/physics/maneuver_planner.py#L276-L281)).
   - The baseline row instead reports the model-consistency difference
     ([propagation models](../concepts/propagation-models.md#model-consistency)).
5. **Score** ([maneuver_planner.py:283-292](../../../backend/app/physics/maneuver_planner.py#L283-L292)):

   ```
   J = |Δv| / budget(1.0 m/s)
     + max(0, log10(Pc_post / 1e-6))          if Pc computed
       or max(0, (5 km − miss_post) / 5 km)   otherwise
     + 1000                                   if infeasible
   ```

   The sort key is J, then the larger post miss, then the earlier burn
   ([maneuver_planner.py:310](../../../backend/app/physics/maneuver_planner.py#L310)). A candidate that
   meets the target has a risk term of 0, so passing candidates compete on Δv alone.
6. **Diverse recommendation.** The recommender takes feasible, target-meeting candidates, one per
   distinct direction first, and fills up with the next best if needed
   ([maneuver_planner.py:325-347](../../../backend/app/physics/maneuver_planner.py#L325-L347)).
7. **IDs** are `MV-<secondary short id>-<nnn>`, numbered in grid order, for example `MV-DEB-2047-066`.

`maneuvered_primary()` turns an approved candidate into a `NUMERICAL_J2` object that starts from the
post-burn state ([maneuver_planner.py:350-355](../../../backend/app/physics/maneuver_planner.py#L350-L355)).
Secondary screening and the post-burn trajectory endpoint both use it.

## Measured on the synthetic scenario

The plan took 4.7 s and evaluated 120 candidates; 90 were feasible and 30 met the target.

- **Every 2.0-orbit lead is infeasible.** With a 5 578 s period, the burn would fall before the window
  start.
- **The recommendation** was −T 0.05 m/s at 1.5 orbits, ahead of +T 0.10 m/s at 1.5 orbits and
  −R 0.35 m/s at 0.5 orbits.
- **No ±N candidate met the target.**

The reasons are in [avoidance maneuvers](../concepts/avoidance-maneuvers.md#why-direction-and-lead-time-matter),
and the numbers are in the [baseline run](../analyses/2026-10-17-baseline-pipeline-run.md).

## Invariants and gotchas

- **Lead times are multiples of half an orbit.** That is exactly where cross-track (and, at whole
  orbits, radial) displacements vanish, so the default grid can never recommend ±N. A grid with
  quarter-orbit leads would behave differently. See
  [open questions](../analyses/open-questions.md#planner-grid-excludes-cross-track-burns-by-construction).
- **The ±180 s post-TCA search window** is ample for the default grid. Even 0.5 m/s at 2 orbits shifts
  the arrival time by only a few seconds (≈ 3·Δv·t / v ≈ 17 km / 7.6 km/s). Larger burns would need it
  revisited.
- **Nothing is optimised.** The planner is a deterministic grid search, and the Δv budget is a proxy,
  not a tank state ([maneuver_planner.py:63-69](../../../backend/app/physics/maneuver_planner.py#L63-L69)).
- **Candidates are cached in the session.** They are stored by ID in `sess.maneuvers`, and replanning
  the same conjunction overwrites the plan
  ([service.py:272-274](../../../backend/app/simulation/service.py#L272-L274)).

## Tests

[test_planner.py](../../../backend/tests/test_planner.py) covers:

- candidates are ranked, the recommended 3 are feasible, meet the target and span at least 2
  directions, and the top one has Pc < 1e-6
- the RTN and TEME Δv agree
- along-track burns move the miss by a plausible ~3·Δv·t
- infeasible candidates score ≥ 1000 and carry reasons
- the model difference is < 1 m in the synthetic scenario
- the maneuvered primary starts from the burn state

## See also

[Avoidance maneuvers](../concepts/avoidance-maneuvers.md) ·
[Secondary screening](../concepts/secondary-screening.md) · [Threat states](../concepts/threat-states.md)
