---
title: Agent orchestrator
type: component
tags: [agent, llm, backend]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Agent orchestrator

`agent/orchestrator.run_analysis()` runs the five-tool collision-avoidance workflow with either Gemini
function calling or a deterministic fallback. It logs every tool call and validates the final report
before it can be approved.

The principle behind this component is [agent integrity](../concepts/agent-integrity.md). This page
covers the mechanics.

## Files

| File | Role |
|---|---|
| [orchestrator.py](../../../backend/app/agent/orchestrator.py) | system prompt, provider choice, the two run loops, validation, narrative |
| [tools.py](../../../backend/app/agent/tools.py) | `ToolRegistry` (5 tools + execution log), compact result shapes, JSON-schema declarations |
| [gemini_client.py](../../../backend/app/agent/gemini_client.py) | thin `google-genai` wrapper with manual function calling and history |

## Provider selection

Selection happens in [orchestrator.py:56-71](../../../backend/app/agent/orchestrator.py#L56-L71). The
mode is `gemini` by default, or `deterministic` or `auto`, from `AGENT_MODE` or the request. The
simulator's Settings panel sends the viewer's choice as the request `mode`.

- **`auto`** uses Gemini when `GEMINI_API_KEY` is set and falls back otherwise, with a warning.
- **`gemini`** without a key also falls back, with a warning.
- **The key stays in the backend.** It is never sent to the browser.

## The run

`run_analysis` creates a run record with the status `RUNNING`. It then runs one of the two loops below,
attaches the tool log and the report, and validates the report. A run ends `NEEDS_APPROVAL` when the
report is valid, `INVALID` when it isn't and `INCOMPLETE` when no report was produced. Every run is
stored in `sess.agent_runs`
([orchestrator.py:73-102](../../../backend/app/agent/orchestrator.py#L73-L102)).

**The deterministic loop** ([orchestrator.py:117-202](../../../backend/app/agent/orchestrator.py#L117-L202)):

1. Call `list_conjunctions`. If it finds nothing, the run is `COMPLETED` with a NORMAL narrative.
2. Call `get_conjunction_details` on rank 1, or on the requested conjunction.
3. Call `plan_maneuvers`, then `check_secondary` on each recommended candidate.
4. Pick the first candidate that is feasible, meets the target and returned PASS or LIMITED.
5. Fill six templated paragraphs from the tool outputs and call `generate_report`.

**The Gemini loop** ([orchestrator.py:209-247](../../../backend/app/agent/orchestrator.py#L209-L247)):

1. Send the user prompt, built from the scenario.
2. Execute each function call the model returns and send the results back.
3. Stop as soon as `generate_report` has produced a report.
   - Tool calls are capped at 16. Beyond that, the model is told to report now
     ([config.py:28](../../../backend/app/config.py#L28)).
   - If the model stops without reporting, it gets **one** nudge.
   - The temperature is 0.2 ([gemini_client.py:22](../../../backend/app/agent/gemini_client.py#L22)).

**Tool execution** ([tools.py:93-114](../../../backend/app/agent/tools.py#L93-L114)):

- Each call records its step, arguments, status (`RUNNING`/`OK`/`ERROR`), start time, duration,
  summary and result reference.
- Keys starting with `_` (`_summary`, `_ref`) are stripped before the result goes back to the model.
- Service exceptions and `TypeError`s (bad arguments) become `{"error": …}` rather than crashing the
  run.

## Measured

The deterministic run on the synthetic scenario took 7.5 s, 4.7 s of it in `plan_maneuvers`. It made
7 calls with no errors, passed validation and returned `NEEDS_APPROVAL` with MV-DEB-2047-066
([baseline run](../analyses/2026-10-17-baseline-pipeline-run.md)).

## Invariants and gotchas

- **`list_conjunctions` reuses the session's screening** unless a window or policy is given. The handler
  also takes a `rescreen` flag, but it is **not declared** to the model
  ([tools.py:117-120](../../../backend/app/agent/tools.py#L117-L120) vs.
  [tools.py:252-260](../../../backend/app/agent/tools.py#L252-L260)), so Gemini cannot force a rescreen.
- **Only the top 10 conjunctions** are shown to the model
  ([tools.py:132](../../../backend/app/agent/tools.py#L132)).
- **The Gemini path has only been tested with a scripted fake model**
  ([tests/test_agent.py:68](../../../backend/tests/test_agent.py#L68)). It has never run against the live
  API; see [open questions](../analyses/open-questions.md).

## Tests

[test_agent.py](../../../backend/tests/test_agent.py) covers:

- a deterministic run is valid and logged
- validation rejects an unknown maneuver
- the Gemini loop works with a scripted model
- the function declarations are well formed

## See also

[Agent integrity](../concepts/agent-integrity.md) · [Simulation service](simulation-service.md) ·
[Maneuver planner](maneuver-planner.md)
