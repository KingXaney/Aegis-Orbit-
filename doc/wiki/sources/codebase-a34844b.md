---
title: Aegis Orbit codebase @ a34844b
type: source
kind: code
commit: a34844b7f159009d1f25e5cab500d60bf7c821ca
ingested: 2026-10-17
tags: [codebase]
sources: []
updated: 2026-10-17
---

# Aegis Orbit codebase @ a34844b

This page summarises the first ingest of the Aegis Orbit repository: its initial commit, a complete
collision-avoidance simulator with a FastAPI physics backend, a Gemini/deterministic agent and a
React + CesiumJS frontend.

| | |
|---|---|
| Commit | `a34844b` "Build autonomous orbital collision avoidance simulator" (2026-10-17) |
| Size | 85 tracked files, ~8,400 lines excluding `package-lock.json` and the TLE fixture |
| Working tree at ingest | clean |
| Verified by running | yes, see [baseline pipeline run](../analyses/2026-10-17-baseline-pipeline-run.md) |

## What was read

- **Read in full:** `README.md`, `.env.example`, `backend/app/config.py`, every module in
  `backend/app/physics/`, `data/`, `scenarios/`, `agent/` and `simulation/`, `backend/app/api/routes.py`,
  `backend/app/main.py`, `backend/scripts/build_real_fixture.py`, `data/scenarios/real_catalog.meta.json`,
  `backend/tests/conftest.py`, `test_collision_probability.py`, `test_propagation.py`,
  `test_planner.py`, `frontend/src/simulation/controller.ts`, `trajectory.ts`, `trajectory.test.ts`,
  `frontend/src/globe/frames.ts` and `frontend/package.json`.
- **Read in part:** `frontend/src/globe/scene.ts` (setup, clock sync, conjunction rendering),
  `frontend/src/store/useAppStore.ts` (scenario loading), `backend/app/schemas/models.py` (header) and
  the remaining backend test files (test names only).
- **Not read yet:** `frontend/src/panels/*`, `components/ui.tsx`, `types/api.ts`, `lib/format.ts`,
  `App.tsx`, `spacecraft.ts` and `GlobeView.tsx`. The wiki says nothing about panel-level UI behaviour
  until these are ingested.

## Key takeaways

1. **The backend owns every number.** The LLM picks tools and writes prose, while `generate_report`
   copies numeric fields from session records and `validate_report` checks the recommendation against
   them. See [agent integrity](../concepts/agent-integrity.md).
2. **Uncertainty is labelled, never hidden.** Public GP elements carry no covariance, so Pc comes back
   `UNVERIFIED` rather than fabricated. Every radius, covariance, category and position carries a basis
   label. See [basis labels](../concepts/covariance-and-basis-labels.md).
3. **Two propagation models, never silently swapped.** SGP4 handles catalog objects and two-body + J2
   RK4 handles synthetic states and post-burn arcs. The planner reports the gap between them. See
   [propagation models](../concepts/propagation-models.md).
4. **Safety is checked twice.** A candidate burn must meet the target against the original object
   *and* pass a full-catalog [secondary screening](../concepts/secondary-screening.md) before the human
   can approve it.
5. **Determinism is a feature.** The synthetic scenario is built by back-propagating a designed
   encounter, so it reproduces to millimetres on every reset, and the deterministic agent keeps the
   demo working offline. See [synthetic scenario](../scenarios/synthetic-conjunction.md).

## Pages created from this source

[overview](../overview.md) ·
concepts: [conjunction](../concepts/conjunction.md), [collision probability](../concepts/collision-probability.md),
[basis labels](../concepts/covariance-and-basis-labels.md), [reference frames](../concepts/reference-frames.md),
[propagation models](../concepts/propagation-models.md), [GP elements and TLEs](../concepts/gp-elements-and-tle.md),
[threat states](../concepts/threat-states.md), [avoidance maneuvers](../concepts/avoidance-maneuvers.md),
[secondary screening](../concepts/secondary-screening.md), [agent integrity](../concepts/agent-integrity.md) ·
components: [architecture](../components/architecture.md), [screening pipeline](../components/screening-pipeline.md),
[maneuver planner](../components/maneuver-planner.md), [agent orchestrator](../components/agent-orchestrator.md),
[data layer](../components/data-layer.md), [simulation service and API](../components/simulation-service.md),
[frontend globe](../components/frontend-globe.md) ·
scenarios: [synthetic conjunction](../scenarios/synthetic-conjunction.md), [real ISS](../scenarios/real-iss.md) ·
analyses: [baseline run](../analyses/2026-10-17-baseline-pipeline-run.md), [open questions](../analyses/open-questions.md)

## README claims checked against a run

Every quantitative claim in the README's demo walkthrough held when the code was run. The details are in
the [baseline run](../analyses/2026-10-17-baseline-pipeline-run.md#readme-claims-vs-measurement).
