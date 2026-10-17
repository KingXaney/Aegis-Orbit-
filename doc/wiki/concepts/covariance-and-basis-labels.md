---
title: Uncertainty and basis labels
type: concept
tags: [uncertainty, provenance, honesty]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Uncertainty and basis labels

Every uncertain input in Aegis Orbit carries a label: provided, assumed or unavailable. Every output
inherits that label instead of hiding it, which is the main way the simulator avoids presenting
guesses as measurements.

## Why it matters

Public GP elements (TLEs) come with **no covariance**. A collision probability computed from them would
rest on an invented uncertainty. Rather than invent one silently, the system reports `UNVERIFIED`.
Any illustrative number it does produce is stamped as illustrative wherever it appears: tool outputs,
threat rationales, the agent's report and the UI.

## The labels

| Field | Values | Where set |
|---|---|---|
| `covariance_source` (object) | `PROVIDED` · `ASSUMED_ILLUSTRATIVE` · `UNAVAILABLE` | [catalog.py:45](../../../backend/app/data/catalog.py#L45) |
| `covariance_basis` (Pc result) | `PROVIDED` · `ASSUMED_ILLUSTRATIVE` · `MIXED` · `UNAVAILABLE` | [collision_probability.py:167-172](../../../backend/app/physics/collision_probability.py#L167-L172) |
| Pc `status` | `COMPUTED` · `UNVERIFIED` | [collision_probability.py:157-165](../../../backend/app/physics/collision_probability.py#L157-L165) |
| `radius_basis` | `SCENARIO_DEFINITION` · `ASSUMED_DEFAULT` | [catalog.py:43](../../../backend/app/data/catalog.py#L43) |
| `category_basis` | `INFERRED_FROM_NAME` · `SCENARIO_DEFINITION` | [catalog.py:27](../../../backend/app/data/catalog.py#L27); name rules in [tle.py:55-61](../../../backend/app/data/tle.py#L55-L61) |
| `position_basis` | `PROPAGATED_FROM_GP_ELEMENTS` · `SYNTHETIC_STATE` · `POST_BURN_NUMERICAL (<id>)` | [catalog.py:33](../../../backend/app/data/catalog.py#L33), [maneuver_planner.py:355](../../../backend/app/physics/maneuver_planner.py#L355) |
| `validation_status` | `OK` · `STALE` · `INVALID` | [catalog.py:51](../../../backend/app/data/catalog.py#L51); STALE means the epoch is more than 30 days before the window ([tle.py:149-158](../../../backend/app/data/tle.py#L149-L158)) |
| Threat state | includes `UNVERIFIED` (miss < 10 km, no Pc) | [threat.py:40-43](../../../backend/app/physics/threat.py#L40-L43) |
| Secondary screening | `PASS` · `FAIL` · `LIMITED` | [secondary_screening.py:72-81](../../../backend/app/physics/secondary_screening.py#L72-L81) |

## Where the numbers come from

- **Synthetic scenario.** The 1σ RTN covariances are scenario definitions: AEGIS-1 is 60/200/60 m and
  DEB-2047 is 120/250/120 m. Both are labelled `ASSUMED_ILLUSTRATIVE`
  ([synthetic.py:96-99](../../../backend/app/scenarios/synthetic.py#L96-L99)). The five background
  objects have none.
- **The `illustrative_default` policy.** It applies placeholder sigmas (R/T/N metres) by category:
  payload 200/1000/200, rocket body 300/1500/300, debris and unknown 300/2000/300. The code describes
  them as "loosely representative of TLE-class accuracy near epoch; not derived from any real
  covariance" ([collision_probability.py:32-40](../../../backend/app/physics/collision_probability.py#L32-L40)).
  Along-track uncertainty dominates. That matches the general behaviour of TLE errors, which grow
  fastest along-track *(background)*.

## Pitfalls

- **`provided_only` does not mean "only `PROVIDED` covariances".** It means "use whatever covariance
  is attached to the object". The synthetic objects carry illustrative covariances, so under the
  default policy their Pc is `COMPUTED` with basis `ASSUMED_ILLUSTRATIVE`
  ([collision_probability.py:133-139](../../../backend/app/physics/collision_probability.py#L133-L139)).
  The threat rationale says "(illustrative)" for exactly this reason
  ([threat.py:31](../../../backend/app/physics/threat.py#L31)).
- **The UI enlarges objects and markers for visibility.** The panels show computed distances; the
  globe does not ([registry.py:46-49](../../../backend/app/scenarios/registry.py#L46-L49)).

## See also

[Collision probability](collision-probability.md) · [Threat states](threat-states.md) ·
[GP elements and TLEs](gp-elements-and-tle.md) · [Agent integrity](agent-integrity.md)
