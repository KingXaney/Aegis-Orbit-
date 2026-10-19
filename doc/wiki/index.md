# Index

Every page in the wiki, grouped by type. Agents read this first on every query. The format is
`[Title](path) — summary · sources · updated`.

## Overview

- [Overview](overview.md) — What Aegis Orbit does, the predict → screen → assess → plan → re-check → explain → decide pipeline, and five recurring design commitments · 1 source · updated 2026-10-17

## Concepts

- [Conjunction, TCA and miss distance](concepts/conjunction.md) — A predicted close approach, described by its time of closest approach, miss distance and relative speed · 1 source · updated 2026-10-17
- [Collision probability (Pc)](concepts/collision-probability.md) — The probability that the hard bodies overlap, from the 2-D encounter-plane (Foster) method, computed only when covariance exists · 1 source · updated 2026-10-17
- [Uncertainty and basis labels](concepts/covariance-and-basis-labels.md) — Every uncertain input carries a provided/assumed/unavailable label that the outputs inherit · 1 source · updated 2026-10-17
- [Threat states](concepts/threat-states.md) — NORMAL, MONITORING, UNVERIFIED, ELEVATED, CRITICAL and MITIGATED, set only by backend rules · 1 source · updated 2026-10-17
- [Avoidance maneuvers](concepts/avoidance-maneuvers.md) — Impulsive RTN burns, and why direction and lead time matter more than burn size · 1 source · updated 2026-10-17
- [Secondary screening](concepts/secondary-screening.md) — Re-screening a burn's new trajectory against the whole catalog; PASS, FAIL and LIMITED · 1 source · updated 2026-10-17
- [Agent integrity](concepts/agent-integrity.md) — The LLM picks tools and writes prose; every number comes from tools, and a validator checks the report · 1 source · updated 2026-10-17
- [Propagation models](concepts/propagation-models.md) — SGP4 for catalog objects, two-body + J2 RK4 for synthetic and post-burn arcs, never silently swapped · 1 source · updated 2026-10-17
- [Reference frames and time](concepts/reference-frames.md) — TEME as the canonical frame, RTN for burns and covariances, Earth-fixed for display, unix seconds in UTC · 1 source · updated 2026-10-17
- [GP elements and TLEs](concepts/gp-elements-and-tle.md) — Public mean-element sets from CelesTrak: validation, epochs, staleness, and why they carry no covariance · 1 source · updated 2026-10-17

## Components

- [System architecture](components/architecture.md) — A FastAPI backend that owns physics and state, a React + Cesium frontend that only interpolates and draws, and one service layer for HTTP and the agent · 1 source · updated 2026-10-17
- [Screening pipeline](components/screening-pipeline.md) — Band filter, batch propagation, local minima, Brent refinement, co-orbital rejection, dedupe and rank · 1 source · updated 2026-10-17
- [Maneuver planner](components/maneuver-planner.md) — A 120-candidate RTN grid search with a documented objective and a diverse top-3 recommendation · 1 source · updated 2026-10-17
- [Agent orchestrator](components/agent-orchestrator.md) — The deterministic run loop, the tool registry and log, report validation · 1 source · updated 2026-10-18
- [Simulation session, service layer and REST API](components/simulation-service.md) — Per-scenario in-memory state, the shared operations, approve and reject, the `/api` routes · 1 source · updated 2026-10-17
- [Data layer](components/data-layer.md) — The OrbitalObject model, TLE parsing, the CelesTrak cache, the fixture vs live catalog · 1 source · updated 2026-10-17
- [Frontend globe, clock and interpolation](components/frontend-globe.md) — One simulation clock, Hermite interpolation, TEME → Earth-fixed every frame, Cesium clock sync · 1 source · updated 2026-10-17

## Scenarios

- [Synthetic conjunction](scenarios/synthetic-conjunction.md) — The scripted AEGIS-1 vs DEB-2047 encounter (354 m, CRITICAL), and why a retrograde burn wins · 1 source · updated 2026-10-17
- [Real ISS](scenarios/real-iss.md) — The ISS vs 399 cataloged objects over 24 h: 12 passes, all with UNVERIFIED Pc · 1 source · updated 2026-10-17

## Analyses

- [Baseline pipeline run (2026-10-17)](analyses/2026-10-17-baseline-pipeline-run.md) — Measured output of both scenarios at a34844b; the source of every number the wiki quotes · 1 source · updated 2026-10-17
- [Open questions and findings](analyses/open-questions.md) — One possible bug (LIMITED masks FAIL), design questions, unmeasured behaviour, sources worth adding · 1 source · updated 2026-10-17

## Sources

- [Aegis Orbit codebase @ a34844b](sources/codebase-a34844b.md) — The initial commit: what was read, the key takeaways, the pages it produced · ingested 2026-10-17
