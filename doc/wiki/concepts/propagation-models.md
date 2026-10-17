---
title: Propagation models (SGP4 vs two-body + J2)
type: concept
tags: [propagation, physics]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Propagation models (SGP4 vs two-body + J2)

Aegis Orbit uses two propagators and never silently swaps one for the other. Catalog objects get SGP4,
and synthetic states and post-burn arcs get a two-body + J2 RK4 integrator. Where the two meet, the
difference is reported.

## The two models

| | SGP4 | Two-body + J2 (`NUMERICAL_J2`) |
|---|---|---|
| Applies to | objects defined by GP/TLE mean elements | synthetic states; the primary after a burn |
| Physics | analytic theory incl. drag, J2–J4 and resonance terms ([propagation.py:9-12](../../../backend/app/physics/propagation.py#L9-L12)) | point mass + J2 only; no drag, no higher harmonics |
| Method | `sgp4` library, batched via `SatrecArray` ([propagation.py:186-204](../../../backend/app/physics/propagation.py#L186-L204)) | fixed-step RK4, ≤ 10 s sub-steps, lands exactly on each requested time, forward or backward ([propagation.py:120-154](../../../backend/app/physics/propagation.py#L120-L154)) |
| Failure mode | error codes 1–6 per sample → NaN, status `PARTIAL`/`FAILED` ([propagation.py:71-86](../../../backend/app/physics/propagation.py#L71-L86), [tle.py:19-26](../../../backend/app/data/tle.py#L19-L26)) | needs an initial state; otherwise `FAILED` |
| Accuracy | mean-element estimate; error grows from the epoch, km-level after about a day ([screening.py:279-281](../../../backend/app/physics/screening.py#L279-L281)) | integrator error is tiny; model error comes from the missing physics |

`propagate()` dispatches on `obj.propagation_model`. An unknown model fails loudly rather than falling
back to the other propagator ([propagation.py:175-183](../../../backend/app/physics/propagation.py#L175-L183)).

## Model consistency

The planner takes the primary's *native* state at the burn time and continues with the J2 model. To
show how much of any change is model artefact rather than maneuver effect, it also propagates a
**zero-Δv baseline** with the J2 model and reports `model_difference_km` against the screening result
([maneuver_planner.py:19-23](../../../backend/app/physics/maneuver_planner.py#L19-L23),
[maneuver_planner.py:264-274](../../../backend/app/physics/maneuver_planner.py#L264-L274)).

- In the **synthetic** scenario both objects are numerical, so the difference is 0.000 km at every
  lead time ([baseline run](../analyses/2026-10-17-baseline-pipeline-run.md); test in
  [test_planner.py:46-48](../../../backend/tests/test_planner.py#L46-L48)).
- For an **SGP4 primary** the docstring expects "up to a few km over several hours"
  ([propagation.py:10-12](../../../backend/app/physics/propagation.py#L10-L12)). This hasn't been
  measured yet; see [open questions](../analyses/open-questions.md).

## Tested properties

[test_propagation.py](../../../backend/tests/test_propagation.py) covers:

- energy conserved to 1e-9 relative over two periods without J2, and a return to the start after one
  period at metre level (L28)
- J2 nodal regression within 3 % of the secular rate −1.5 n J2 (R_E/a)² cos i. That is about −5°/day at
  420 km and 51.6° (L41).
- a forward-then-backward round trip over 2 h within 1 cm (L54)
- batch propagation matching individual propagation

## Why J2

J2, Earth's oblateness, is the dominant perturbation in LEO. It turns the orbit plane (nodal regression)
and the line of apsides by degrees per day *(background)*. A pure two-body model would misplace a LEO
object by tens of km within hours, whereas J2-only is a reasonable short-arc approximation for
post-burn trajectories.

## See also

[GP elements and TLEs](gp-elements-and-tle.md) · [Reference frames](reference-frames.md) ·
[Maneuver planner](../components/maneuver-planner.md)
