---
title: Agent orchestrator
type: component
tags: [agent, backend]
sources: [codebase-a34844b]
updated: 2026-10-18
---

# Agent orchestrator

`agent/orchestrator.run_analysis()` runs the five-tool collision-avoidance workflow with a
deterministic, rule-based agent. It logs every tool call and validates the final report before it can
be approved.

The principle behind this component is [agent integrity](../concepts/agent-integrity.md). This page
covers the mechanics. An earlier version also offered a Gemini function-calling provider; it was
removed on 2026-10-18 and the deterministic agent is now the only provider (see
[log](../log.md)).

## Files

| File | Role |
|---|---|
| [orchestrator.py](../../../backend/app/agent/orchestrator.py) | the run loop, validation, narrative |
| [tools.py](../../../backend/app/agent/tools.py) | `ToolRegistry` (5 tools + execution log), compact result shapes |

## The run

`run_analysis` creates a run record with the status `RUNNING`, runs the loop below, attaches the tool
log and the report, and validates the report. A run ends `NEEDS_APPROVAL` when the report is valid,
`INVALID` when it isn't and `INCOMPLETE` when no report was produced. Every run is stored in
`sess.agent_runs` ([orchestrator.py:26-55](../../../backend/app/agent/orchestrator.py#L26-L55)).

**The workflow** ([orchestrator.py:65-150](../../../backend/app/agent/orchestrator.py#L65-L150)):

1. Call `list_conjunctions`. If it finds nothing, the run is `COMPLETED` with a NORMAL narrative.
2. Call `get_conjunction_details` on rank 1, or on the requested conjunction.
3. Call `plan_maneuvers`, then `check_secondary` on each recommended candidate.
4. Pick the first candidate that is feasible, meets the target and returned PASS or LIMITED.
5. Fill six templated paragraphs from the tool outputs and call `generate_report`.

**Tool execution** ([tools.py:94-116](../../../backend/app/agent/tools.py#L94-L116)):

- Each call records its step, arguments, status (`RUNNING`/`OK`/`ERROR`), start time, duration,
  summary and result reference.
- Keys starting with `_` (`_summary`, `_ref`) are stripped from the logged result summary.
- Service exceptions and `TypeError`s (bad arguments) become `{"error": …}` rather than crashing the
  run.

## Measured

The deterministic run on the synthetic scenario took 7.5 s, 4.7 s of it in `plan_maneuvers`. It made
7 calls with no errors, passed validation and returned `NEEDS_APPROVAL` with MV-DEB-2047-066
([baseline run](../analyses/2026-10-17-baseline-pipeline-run.md)).

## Invariants and gotchas

- **`list_conjunctions` reuses the session's screening** unless a window or policy is given
  ([tools.py:118-134](../../../backend/app/agent/tools.py#L118-L134)).
- **Only the top 10 conjunctions** are listed in the tool result
  ([tools.py:134](../../../backend/app/agent/tools.py#L134)).

## Tests

[test_agent.py](../../../backend/tests/test_agent.py) covers:

- a run is valid and logged, with the expected tool sequence
- validation rejects an unknown maneuver
- a tool failure still returns a (FAILED) run record

## See also

[Agent integrity](../concepts/agent-integrity.md) · [Simulation service](simulation-service.md) ·
[Maneuver planner](maneuver-planner.md)
