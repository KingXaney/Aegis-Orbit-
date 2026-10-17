---
title: Threat states
type: concept
tags: [risk, state-machine]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Threat states

Six labels summarise how worried to be about a conjunction or a session: `NORMAL`, `MONITORING`,
`UNVERIFIED`, `ELEVATED`, `CRITICAL` and `MITIGATED`. Backend rules assign them from computed values
and configured thresholds. The LLM never assigns them.

## Rules for one conjunction

From [threat.py:26-46](../../../backend/app/physics/threat.py#L26-L46):

```
if Pc was computed:
    Pc ≥ 1e-4  → CRITICAL
    Pc ≥ 1e-5  → ELEVATED
    otherwise  → MONITORING
else (no covariance):
    miss < 10 km → UNVERIFIED
    otherwise    → MONITORING
```

The rationale string records the Pc value, whether the covariance was illustrative or provided, and
the threshold it crossed. For example: `Pc 5.74e-04 (illustrative) >= critical threshold 1e-04`.

The thresholds are demonstration settings in [config.py:43-47](../../../backend/app/config.py#L43-L47),
not operational standards.

## Severity order and the session state

`ORDER = [NORMAL, MONITORING, UNVERIFIED, ELEVATED, CRITICAL]`
([threat.py:23](../../../backend/app/physics/threat.py#L23)). A session's overall state is the worst
state among its conjunctions, or `NORMAL` if there are none
([session.py:46-51](../../../backend/app/simulation/session.py#L46-L51)).

**`MITIGATED` is not in `ORDER`.** It is a session-level state set only when a human approves a
maneuver, and only if three conditions hold ([service.py:319-326](../../../backend/app/simulation/service.py#L319-L326)):

1. the post-burn encounter meets the mitigation target,
2. secondary screening returned `PASS`, not merely `LIMITED`, and
3. every new or remaining approach is at worst `MONITORING`.

Otherwise the session takes the worst of the post-burn state and the remaining states.

## Mitigation target

From [threat.py:49-59](../../../backend/app/physics/threat.py#L49-L59): if Pc can be computed, the
target is **Pc ≤ 1e-6**. Without a covariance it falls back to **miss ≥ 5 km**. The `target_basis` text
says which test was applied.

## Measured

- The designed synthetic encounter is CRITICAL. Its six repeat encounters with the same debris are
  MONITORING. After approving MV-DEB-2047-066 the session is MITIGATED.
- On the real ISS scenario, the closest pass (6.7 km) is UNVERIFIED and the other 11 are MONITORING.

Both from the [baseline run](../analyses/2026-10-17-baseline-pipeline-run.md).

## Pitfalls

- `UNVERIFIED` ranks *above* `MONITORING` but *below* `ELEVATED`. An unquantifiable close approach is
  treated as worse than a quantified small risk, but not as a confirmed high one.
- An approval with `LIMITED` secondary screening is allowed but never reaches `MITIGATED`. See
  [secondary screening](secondary-screening.md) and [open questions](../analyses/open-questions.md).

## See also

[Collision probability](collision-probability.md) · [Secondary screening](secondary-screening.md) ·
[Simulation service](../components/simulation-service.md)
