---
title: Collision probability (Pc)
type: concept
tags: [risk, physics]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Collision probability (Pc)

Pc is the probability that two objects' hard bodies overlap during an encounter, given Gaussian
uncertainty in their positions. Aegis Orbit computes it with the two-dimensional encounter-plane
(Foster) method, and only when covariance inputs exist.

## Definition

For a short, fast encounter, relative motion through the encounter is close to a straight line. The
problem then collapses onto the **encounter plane**, the plane perpendicular to the relative velocity
at TCA:

1. Rotate each object's 3×3 position covariance from RTN into TEME and add the two:
   C = C_p + C_s.
2. Project C and the miss vector onto the plane. This gives a 2×2 covariance C₂ and a 2-D miss m.
3. Pc = ∬ over |x| ≤ HBR of N(x; m, C₂) dx. That is the Gaussian probability mass inside a disk whose
   radius is the **hard-body radius** (HBR), the sum of the two object radii.

The method assumes rectilinear relative motion, Gaussian position errors that are independent and
constant through the encounter, negligible velocity uncertainty and spherical bodies
([collision_probability.py:78-83](../../../backend/app/physics/collision_probability.py#L78-L83)). These
assumptions are attached to every result.

## In Aegis Orbit

- **Quadrature.** The integral uses 48 Gauss–Legendre nodes in radius and a 256-point trapezoid in
  angle ([collision_probability.py:105-124](../../../backend/app/physics/collision_probability.py#L105-L124)).
  Tests check it against the exact isotropic solution, a non-central χ² with 2 degrees of freedom, to
  1e-9 relative
  ([test_collision_probability.py:9-14](../../../backend/tests/test_collision_probability.py#L9-L14)).
  They also check rotation invariance and that Pc decreases monotonically with miss distance
  ([test_collision_probability.py:17](../../../backend/tests/test_collision_probability.py#L17)).
- **Encounter-plane basis.** e₁ lies along the in-plane miss and e₂ = ŵ × e₁, where ŵ is the
  relative-velocity direction. The degenerate zero-miss case is handled
  ([collision_probability.py:86-97](../../../backend/app/physics/collision_probability.py#L86-L97)).
- **Hard-body radius.** Default radii by category are payload 5 m, rocket body 5 m, debris 1 m and
  unknown 2 m ([catalog.py:19](../../../backend/app/data/catalog.py#L19)). The ISS is overridden to 55 m
  ([real.py:32](../../../backend/app/scenarios/real.py#L32)). The synthetic pair is 7.5 m + 2.5 m = 10 m.
- **Policies.** `provided_only` (the default) returns `UNVERIFIED` whenever either object lacks a
  covariance. `illustrative_default` substitutes documented placeholder sigmas
  ([collision_probability.py:32-43](../../../backend/app/physics/collision_probability.py#L32-L43)). The
  result's `covariance_basis` records which happened; see
  [basis labels](covariance-and-basis-labels.md).
- **Measured.** The designed synthetic encounter gives Pc = 5.74e-4 (illustrative covariance,
  combined sigmas 285 m × 134 m, HBR 10 m), which is CRITICAL. Encounters 6–8 km away give 1e-116 to
  1e-195, effectively zero
  ([baseline run](../analyses/2026-10-17-baseline-pipeline-run.md#synthetic-scenario-synthetic-conjunction)).

## Pitfalls

- **Low Pc can mean "we don't know".** Pc is not monotonic in uncertainty. Once the covariance grows
  much larger than the miss distance, the probability mass spreads out and Pc *falls*, the so-called
  dilution region *(background)*. A small Pc computed from a huge covariance is not evidence of
  safety. Aegis Orbit doesn't detect dilution yet; see [open questions](../analyses/open-questions.md).
- **Burns are assumed not to change the covariance.** After a maneuver the same covariance is reused,
  with no execution error ([maneuver_planner.py:63-69](../../../backend/app/physics/maneuver_planner.py#L63-L69)).
- **Thresholds are demo settings.** The CRITICAL (1e-4) and ELEVATED (1e-5) levels and the 1e-6
  target are configuration, not operational standards
  ([config.py:43-45](../../../backend/app/config.py#L43-L45)).

## See also

[Basis labels](covariance-and-basis-labels.md) · [Reference frames](reference-frames.md) ·
[Threat states](threat-states.md) · [Conjunction](conjunction.md)
