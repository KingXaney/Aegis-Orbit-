---
title: Open questions and findings
type: analysis
tags: [questions, lint, todo]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Open questions and findings

This is the standing list of possible bugs, design questions, unmeasured behaviour and missing sources
surfaced while building and linting the wiki. Each item states its evidence. None of them has been
changed in code; wiki workflows never edit code.

## Possible bugs

### LIMITED masks FAIL in secondary screening

**Status: open.**

`check_secondary` returns `LIMITED` whenever the screening was incomplete, *before* it checks the FAIL
conditions ([secondary_screening.py:76-81](../../../backend/app/physics/secondary_screening.py#L76-L81)).
An incomplete screen therefore reports `LIMITED` even when it found a new CRITICAL approach, or when
the candidate misses the target against the original object. Three places treat `LIMITED` as
acceptable:

- the deterministic agent's candidate choice
  ([orchestrator.py:137-138](../../../backend/app/agent/orchestrator.py#L137-L138))
- report validation ([orchestrator.py:276-277](../../../backend/app/agent/orchestrator.py#L276-L277))
- approval, which blocks only `FAIL`
  ([service.py:313](../../../backend/app/simulation/service.py#L313))

The session would not reach MITIGATED, which requires `PASS`, but the approval would go through.
*It can't be triggered on the current scenarios:* both screens complete with no propagation failures.
A possible fix is to evaluate the FAIL conditions first and report `LIMITED` only when nothing failing
was found, or to return both an incompleteness flag and a verdict.

## Design questions

### Planner grid excludes cross-track burns by construction

**Status: open.**

All four default lead times (0.5, 1.0, 1.5 and 2.0 orbits) are multiples of half an orbit
([config.py:50](../../../backend/app/config.py#L50)). That is exactly where a cross-track burn's
displacement returns to zero. Radial burns at whole-orbit leads also return to zero. In the baseline
run, no ±N candidate met the target, and −R at 1.0 orbit left the miss unchanged
([baseline run](2026-10-17-baseline-pipeline-run.md#synthetic-scenario-synthetic-conjunction);
explanation in [avoidance maneuvers](../concepts/avoidance-maneuvers.md#why-direction-and-lead-time-matter)).
The "diverse directions" recommendation therefore can never include N.

The open question is whether that is intended. Adding quarter-orbit leads such as 0.75 and 1.25 would
let radial and cross-track options compete. That matters operationally, because cross-track burns
barely change the orbit's altitude profile *(background)*.

### The agent's prose is not validated

**Status: open.**

`validate_report` checks IDs, the threat miss distance and the candidate's properties
([orchestrator.py:254-288](../../../backend/app/agent/orchestrator.py#L254-L288)). It does not check
the six prose fields, where a Gemini narrative could misquote a number. Two options: extract the
numbers from the prose and cross-check them against tool outputs, or render every number in the UI
from structured fields only.

### Tool errors do not invalidate a run

**Status: open, possibly intended.**

`no_tool_errors` is reported but excluded from the verdict
([orchestrator.py:287](../../../backend/app/agent/orchestrator.py#L287)). That is reasonable if the
model recovers from a bad call, but a reviewer may expect a run with errors to be flagged.

### No Pc dilution warning

**Status: open.**

A low Pc can come from a very large covariance relative to the miss distance (dilution) *(background)*.
Nothing flags that case
([collision probability](../concepts/collision-probability.md#pitfalls)). It matters most under the
`illustrative_default` policy, whose along-track sigmas run to 1–2 km.

### `rescreen` is not exposed to the model

**Status: open, minor.**

`list_conjunctions` accepts `rescreen`, but its function declaration omits it
([tools.py:117-120](../../../backend/app/agent/tools.py#L117-L120),
[tools.py:252-260](../../../backend/app/agent/tools.py#L252-L260)).

### The fixture and live builders exclude ISS entries differently

**Status: open, minor.**

`ISS DEB` is excluded by exact name in the fixture builder but not in the live builder
([data layer](../components/data-layer.md#invariants-and-gotchas)).

## Not measured yet

- **The Gemini provider live.** It is tested only with a scripted fake model
  ([test_agent.py:68](../../../backend/tests/test_agent.py#L68)). Run it once a `GEMINI_API_KEY` is
  available, and file the run as an analysis.
- **The planner on `real-iss`.** This would exercise the distance target, because no Pc exists, and
  the SGP4-vs-J2 model difference, which the docstring expects to reach a few km over several hours
  ([propagation.py:10-12](../../../backend/app/physics/propagation.py#L10-L12)). The top conjunction
  (6.7 km) already satisfies the 5 km distance target, so what should the agent recommend for an
  UNVERIFIED threat that needs no maneuver by the target's definition?
- **Screening on denser catalogs.** The coarse-step merge limitation has not been probed on more
  crowded data ([screening pipeline](../components/screening-pipeline.md#invariants-and-gotchas)).
- **The frontend panels.** They have not been ingested
  ([source page](../sources/codebase-a34844b.md#what-was-read)).

## Sources worth adding

Dropping any of these into [`raw/`](../../raw/) and ingesting it would replace the wiki's
*(background)* markers with citations:

| Source | Would back |
|---|---|
| NASA, *Spacecraft Conjunction Assessment and Collision Avoidance Best Practices Handbook* | operational Pc thresholds, dilution, maneuver practice, secondary screening |
| Vallado, Crawford, Hujsak & Kelso (2006), *Revisiting Spacetrack Report #3* | SGP4, TEME, the error growth of GP elements |
| Foster & Estes (1992), NASA JSC report on 2-D collision probability | the method in [collision probability](../concepts/collision-probability.md) |
| Alfano (2005), *Relating Position Uncertainty to Maximum Conjunction Probability* | Pc dilution, worst-case Pc |
| Clohessy & Wiltshire (1960), *Terminal Guidance System for Satellite Rendezvous* | the relative-motion results in [avoidance maneuvers](../concepts/avoidance-maneuvers.md) |
| CelesTrak documentation of GP data formats | the TLE fields and GP semantics in [GP elements and TLEs](../concepts/gp-elements-and-tle.md) |
