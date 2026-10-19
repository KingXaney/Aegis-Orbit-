---
title: Simulation session, service layer and REST API
type: component
tags: [backend, api, state]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Simulation session, service layer and REST API

`simulation/session.py` holds everything computed for one scenario. `simulation/service.py` holds the
operations shared by the REST routes and the agent tools: screening, planning, checks, trajectories and
human decisions. `api/routes.py` is a thin HTTP shell over the service layer.

## Session

A `SimulationSession` holds the following, keyed by ID
([session.py:23-37](../../../backend/app/simulation/session.py#L23-L37)):

- the `Scenario`
- `conjunctions`, `screening` with its `screening_pc_policy`, and `plans`
- `maneuvers`, `secondary_checks`, `agent_runs` and `decisions`
- `approved_maneuver_id` and `post_approval`

`SessionStore` keeps one session per scenario behind a lock. `reset()` rebuilds the session from
scratch and increments `reset_count`
([session.py:88-107](../../../backend/app/simulation/session.py#L88-L107)). Everything is in memory, so
restarting the backend clears it.

## Service operations

| Function | What it does |
|---|---|
| `run_screening` | screens the primary, attaches Pc and threat state to each conjunction and replaces the session's conjunctions ([service.py:182-217](../../../backend/app/simulation/service.py#L182-L217)) |
| `plan_for_conjunction` | runs the [planner](maneuver-planner.md) and stores the plan and its candidates ([service.py:254-277](../../../backend/app/simulation/service.py#L254-L277)) |
| `run_secondary_check` | runs [secondary screening](../concepts/secondary-screening.md) and stores a summary on the candidate ([service.py:287-301](../../../backend/app/simulation/service.py#L287-L301)) |
| `trajectory` | returns samples in TEME; with `maneuver_id`, the native model before the burn and J2 after it, split into labelled segments ([service.py:111-162](../../../backend/app/simulation/service.py#L111-L162)) |
| `approve` / `reject` | the human decision ([service.py:308-346](../../../backend/app/simulation/service.py#L308-L346)) |

**Trajectory limits.** A request is capped at 20 000 samples
([service.py:25](../../../backend/app/simulation/service.py#L25)). Positions are rounded to 1 m and
velocities to 1 mm/s, and failed samples come back as `null`.

## Approve / reject

`approve(maneuver_id)` runs these steps:

1. Refuses an infeasible candidate with HTTP 409.
2. Runs the secondary check if it is missing.
3. Refuses `FAIL` with HTTP 409.
4. Records an `APPROVED` decision.
5. Computes `post_approval.overall_threat_state`. This is `MITIGATED` only if the target is met, the
   check returned `PASS` and every other approach is at worst `MONITORING`
   ([service.py:308-336](../../../backend/app/simulation/service.py#L308-L336)).

`reject` records the decision and, if it rejects the currently approved maneuver, restores the
original trajectory. Every decision record says that no command is sent to any spacecraft
([session.py:71-85](../../../backend/app/simulation/session.py#L71-L85)).

Approval checks feasibility and FAIL, not `meets_target` directly. FAIL already covers a missed target,
except when screening is `LIMITED`; see
[open questions](../analyses/open-questions.md#limited-masks-fail-in-secondary-screening).

## REST API

All routes are under `/api` ([routes.py](../../../backend/app/api/routes.py)).

| Route | Purpose |
|---|---|
| `GET /health` | status, version, the agent kind, whether network is allowed, scenario list, disclaimer |
| `GET /scenarios`, `GET /scenarios/{id}` | scenario summaries; detail includes the window, data source, thresholds and simulation state |
| `POST /scenarios/{id}/reset?live=` | rebuilds the session; `live=true` re-downloads the real catalog |
| `GET /objects?scenario_id=`, `GET /objects/{id}?at=` | catalog listing; object detail with its state in TEME, geodetic and osculating elements |
| `GET /objects/{id}/trajectory`, `POST /objects/trajectories` | trajectory samples (batch of at most 200 objects); `maneuver_id` gives the post-burn version |
| `POST /conjunctions/screen`, `GET /conjunctions`, `GET /conjunctions/{id}` | screen, or read back the current results |
| `POST`/`GET /conjunctions/{id}/maneuvers` | plan, or read back the existing plan |
| `POST /maneuvers/{id}/secondary-check` | secondary screening for one candidate |
| `POST /agent/analyze` | run the deterministic agent on the scenario (optionally a named conjunction) |
| `GET /simulation/state`, `POST /simulation/approve`, `POST /simulation/reject` | the human-in-the-loop state |
| `POST /data/refresh` | downloads fresh CelesTrak groups and rebuilds `real-iss` |

The interactive OpenAPI docs are served at `/docs` when the backend runs.

## Tests

[test_api.py](../../../backend/tests/test_api.py) covers:

- health and scenarios
- objects and trajectories
- the full workflow including approval
- planning requires a screening first
- the real scenario stays honest about uncertainty: every Pc is UNVERIFIED and PROGRESS is co-orbital
  ([test_api.py:84](../../../backend/tests/test_api.py#L84))

## See also

[Architecture](architecture.md) · [Agent orchestrator](agent-orchestrator.md) ·
[Threat states](../concepts/threat-states.md)
