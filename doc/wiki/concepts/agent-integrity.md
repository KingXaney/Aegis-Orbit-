---
title: Agent integrity (tools own the numbers)
type: concept
tags: [agent, llm, safety]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Agent integrity (tools own the numbers)

The LLM in Aegis Orbit only chooses which backend tools to call and writes explanatory prose. Every
number, ID and threat state in its report comes from tool results. A validator checks the
recommendation against session records before a human sees it.

## The contract

The system prompt sets the agent up as a reasoning layer that never computes orbital numbers
([orchestrator.py:28-49](../../../backend/app/agent/orchestrator.py#L28-L49)). It must:

- follow a fixed order:
  `list_conjunctions → get_conjunction_details → plan_maneuvers → check_secondary` (for every
  candidate it might recommend) `→ generate_report` (once)
- report threat states as given, never upgrading or downgrading them
- say plainly when Pc is `UNVERIFIED` or illustrative
- distinguish computed values, thresholds, assumptions and illustrative estimates
- recommend only a feasible, target-meeting candidate that passed secondary screening, or set
  `no_action_recommended`
- end by stating that approval is a human decision and nothing is commanded

## How it's enforced

1. **Structured tools.** Each tool wraps a service call and returns a dictionary. Each call is logged
   with its step, arguments, status, duration and summary
   ([tools.py:93-114](../../../backend/app/agent/tools.py#L93-L114)).
2. **The report is backend-filled.** In `generate_report` the agent supplies only the IDs and six prose
   fields. The threat record, the candidates considered, the secondary checks, the thresholds and the
   assumptions are copied from the session
   ([tools.py:198-245](../../../backend/app/agent/tools.py#L198-L245)). The report says so in its `note`
   field.
3. **Validation** runs these checks ([orchestrator.py:254-288](../../../backend/app/agent/orchestrator.py#L254-L288)):

| Check | Requires |
|---|---|
| `threat_exists` | the reported conjunction is in the session |
| `threat_numbers_match` | the report's miss distance equals the record within 1e-3 km |
| `maneuver_exists` · `maneuver_feasible` · `maneuver_meets_target` | the recommended candidate is real and passes both |
| `secondary_check_run` · `secondary_check_passed` | the check ran, and returned PASS or LIMITED |
| `belongs_to_threat` | the candidate was planned for the reported conjunction |
| `no_action_explicit` | used instead of the four maneuver checks when nothing is recommended |
| `tool_sequence` | list, details and report were all called successfully |
| `no_tool_errors` | reported, but **does not** affect the verdict |

A run ends as `NEEDS_APPROVAL` (valid report), `INVALID`, `INCOMPLETE` (no report), `FAILED`
(exception) or `COMPLETED` (nothing to do)
([orchestrator.py:26-55](../../../backend/app/agent/orchestrator.py#L26-L55)).

## One deterministic workflow

**The agent is deterministic and rule-based**: it runs a fixed tool sequence and fills a template with
the results, so the same session state always produces the same report
([orchestrator.py:1-10](../../../backend/app/agent/orchestrator.py#L1-L10)). Validation still runs on
every report — the structure is kept so any future provider is held to the same checks. Details are in
[agent orchestrator](../components/agent-orchestrator.md). An earlier Gemini function-calling provider
was removed on 2026-10-18 (see [log](../log.md)).

## Pitfalls

- **The prose is templated, not checked.** Validation covers IDs, the threat miss distance and the
  candidate's properties; the six prose fields are filled by the backend template from tool outputs.
- **Tool errors don't invalidate a run.** A run with a failed tool call can still be `VALID`, because
  `no_tool_errors` is excluded from the verdict
  ([orchestrator.py:190](../../../backend/app/agent/orchestrator.py#L190)).

## See also

[Agent orchestrator](../components/agent-orchestrator.md) · [Threat states](threat-states.md) ·
[Basis labels](covariance-and-basis-labels.md)
