---
title: Screening pipeline
type: component
tags: [screening, physics, backend]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Screening pipeline

`physics/screening.screen()` finds every close approach between the primary and a catalog inside a time
window: filter, propagate in a batch, find minima, refine, reject co-orbital pairs, then dedupe and
rank.

## Responsibility

Input: a primary, a list of other objects, `[t_start, t_end]` and thresholds. Output: a
`ScreeningResult` holding ranked `Conjunction`s, statistics, co-orbital rejections and propagation
failures ([screening.py:96-109](../../../backend/app/physics/screening.py#L96-L109)). Pc and threat
states are attached *afterwards* by the service layer
([service.py:205-208](../../../backend/app/simulation/service.py#L205-L208)).

## How it works

All steps are in [screening.py:218-318](../../../backend/app/physics/screening.py#L218-L318).

1. **Validity and band filter.** `INVALID` objects and the primary are dropped. Objects whose
   perigee/apogee band, widened by 50 km, misses the primary's band are dropped too. Objects with an
   unknown band are kept, to stay conservative
   ([screening.py:116-132](../../../backend/app/physics/screening.py#L116-L132)).
2. **Batch propagation** on a 30 s grid. SGP4 objects go through `SatrecArray` together
   ([propagation.py:186-204](../../../backend/app/physics/propagation.py#L186-L204)).
3. **Per pair, a cheap reject.** If the closest coarse sample is farther than 25 km plus 2 × 30 s ×
   16 km/s, the pair is skipped ([screening.py:244](../../../backend/app/physics/screening.py#L244)). If
   the relative speed stays below 0.01 km/s for the whole window while the objects are within the
   radius, the pair is recorded as co-orbital
   ([screening.py:248-255](../../../backend/app/physics/screening.py#L248-L255)).
4. **Local minima** of the separation series. The scan is NaN-aware and reports the first sample of a
   flat bottom ([screening.py:189-205](../../../backend/app/physics/screening.py#L189-L205)). A minimum
   is kept if it lies below 25 km + ½ step × relative speed
   ([screening.py:256-259](../../../backend/app/physics/screening.py#L256-L259)).
5. **Refinement.** Bounded Brent minimisation of the exact separation over the bracketing samples
   `[i−1, i+1]`, to a 1 ms tolerance with at most 200 iterations. Each object uses its own model
   ([screening.py:153-186](../../../backend/app/physics/screening.py#L153-L186)). Numerical objects are
   first **re-anchored** at the bracket start, so each evaluation integrates only a few seconds
   ([screening.py:135-142](../../../backend/app/physics/screening.py#L135-L142)).
6. **Final filters.** Results at or beyond 25 km after refinement are dropped. Results whose relative
   speed at the refined TCA is below 0.01 km/s become co-orbital
   ([screening.py:267-275](../../../backend/app/physics/screening.py#L267-L275)).
7. **Quality notes.** Each conjunction carries both objects' warnings, a STALE flag where relevant and
   a model-specific limitation sentence
   ([screening.py:276-284](../../../backend/app/physics/screening.py#L276-L284)).
8. **Dedupe and rank.** Detections of the same pair within 2 coarse steps are merged, keeping the
   smaller miss. Results are sorted by miss distance and then TCA, and numbered by rank
   ([screening.py:298-301](../../../backend/app/physics/screening.py#L298-L301),
   [screening.py:321-337](../../../backend/app/physics/screening.py#L321-L337)).

## Invariants and gotchas

- **Brent minimises over an offset τ from `t_lo`, not over absolute unix time.** At about 1.8e9 s,
  the optimiser's relative tolerance would be tens of seconds wide
  ([screening.py:160-161](../../../backend/app/physics/screening.py#L160-L161)).
- **The output is complete only if nothing failed.** `stats.complete` is false if any object failed to
  propagate. Downstream, that makes [secondary screening](../concepts/secondary-screening.md) `LIMITED`.
- **Real data screens faster than synthetic.** The real screen (399 objects × 2 881 samples) took
  0.37 s, while the synthetic one (3 candidates × 721 samples) took 0.77 s. Batched SGP4 is much
  cheaper than RK4 at 10 s steps
  ([baseline run](../analyses/2026-10-17-baseline-pipeline-run.md)).
- **Some approaches can be missed.** The documented limitation is that a minimum narrower than the
  step, next to another minimum, can merge with it
  ([screening.py:18-21](../../../backend/app/physics/screening.py#L18-L21)).

## Tests

[test_screening.py](../../../backend/tests/test_screening.py) covers:

- the designed conjunction is detected and refined, and refinement beats the coarse sample
- the background objects don't threaten
- local-minima detection works
- the band filter keeps crossing eccentric orbits
- identical elements are classified co-orbital
- dedupe merges adjacent detections

## See also

[Conjunction](../concepts/conjunction.md) · [Propagation models](../concepts/propagation-models.md) ·
[Secondary screening](../concepts/secondary-screening.md)
