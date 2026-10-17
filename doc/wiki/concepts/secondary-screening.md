---
title: Secondary screening
type: concept
tags: [screening, safety]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Secondary screening

Secondary screening re-screens a candidate maneuver's post-burn trajectory against the whole catalog,
because a burn that clears the original threat can create new close approaches. A maneuver is never
called safe just because it clears the original object.

## How it works

From [secondary_screening.py](../../../backend/app/physics/secondary_screening.py):

1. Build the maneuvered primary as a numerical object that starts from the post-burn state
   ([maneuver_planner.py:350-355](../../../backend/app/physics/maneuver_planner.py#L350-L355)).
2. Run the normal [screening pipeline](../components/screening-pipeline.md) from the burn time to the
   end of the window against every catalog object, and compute Pc and threat states for each hit
   ([secondary_screening.py:29-39](../../../backend/app/physics/secondary_screening.py#L29-L39)).
3. Match each original conjunction after the burn time to a post-burn one with the same secondary
   whose TCA is within ±600 s. A match is `STILL_WITHIN_SCREENING_RADIUS` with before/after values. An
   unmatched original is `CLEARED_BEYOND_25_KM`. Unmatched post-burn hits are **new**
   ([secondary_screening.py:41-68](../../../backend/app/physics/secondary_screening.py#L41-L68)).
4. Assign a verdict ([secondary_screening.py:72-81](../../../backend/app/physics/secondary_screening.py#L72-L81)):

| Verdict | When |
|---|---|
| `LIMITED` | some catalog object could not be propagated (incomplete screening) |
| `FAIL` | a new approach is `UNVERIFIED` or worse, **or** the original encounter misses the target |
| `PASS` | otherwise |

Every result also states that the screening covers only the catalog it was given, for example
"catalog limited to 399 objects".

## Where the verdict is used

- **The agent** may recommend only candidates with `PASS` or `LIMITED`, and the report validation
  checks this ([orchestrator.py:273-277](../../../backend/app/agent/orchestrator.py#L273-L277)).
- **Approval** refuses `FAIL` with HTTP 409, and runs the check first if it hasn't been run
  ([service.py:312-316](../../../backend/app/simulation/service.py#L312-L316)).
- **`MITIGATED`** requires `PASS` ([threat states](threat-states.md)).

## Measured

All three synthetic recommendations returned `PASS`, taking 0.55–0.71 s each
([baseline run](../analyses/2026-10-17-baseline-pipeline-run.md)).

## Pitfalls

- **`LIMITED` is checked before `FAIL`.** An incomplete screening that *also* found a new CRITICAL
  approach, or whose candidate misses the target, still reports `LIMITED`, which both the agent and
  the approval accept. This is filed as a possible bug in
  [open questions](../analyses/open-questions.md#limited-masks-fail-in-secondary-screening).
- **The screen sees only the catalog.** In the real scenario that is 400 objects near the ISS band, so
  a `PASS` says nothing about objects outside it.

## See also

[Avoidance maneuvers](avoidance-maneuvers.md) · [Threat states](threat-states.md) ·
[Screening pipeline](../components/screening-pipeline.md)
