---
title: Baseline pipeline run (2026-10-17)
type: analysis
commit: a34844b
tags: [measurement, synthetic, real-data]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Baseline pipeline run (2026-10-17)

This page records the measured output of the full pipeline at commit `a34844b`: the deterministic
agent run end to end on the synthetic scenario, and a screening of the real ISS scenario. It is the
reference for every number the wiki quotes.

## Method

- Ran with the backend venv (`backend/.venv`, Python 3.12) from a scratch script that imports `app`
  directly, with no HTTP server involved. It called `get_store().reset(...)`, then
  `run_analysis(sess, mode="deterministic")` for the synthetic scenario and `service.run_screening` for
  `real-iss`. It then planned the synthetic threat again to read individual grid points.
- Default settings throughout: no `.env`, so `pc_policy` was `provided_only` with the thresholds from
  [config.py](../../../backend/app/config.py#L36-L55).
- Wall-clock timings come from one run on the author's Mac, so treat them as orders of magnitude.

## Synthetic scenario (`synthetic-conjunction`)

**Screening.** The 6-hour window from 2026-10-17T00:00Z used 721 coarse samples (30 s). 3 of the 6
non-primary objects passed the altitude filter, 7 local minima were refined and 7 conjunctions found, with no co-orbital
objects and no propagation failures. Screening took 0.77 s. **All 7 conjunctions involve the same
debris object**, one at each crossing node, about every 46.5 minutes:

| TCA (UTC) | Miss (km) | Rel. speed (km/s) | Pc | State |
|---|---|---|---|---|
| 00:40:35.8 | 22.905 | 7.68 | 0.0 | MONITORING |
| 01:27:03.0 | 14.272 | 7.66 | 0.0 | MONITORING |
| 02:13:32.9 | 8.346 | 7.67 | 2.7e-195 | MONITORING |
| **03:00:00.000** | **0.353547** | **7.658** | **5.7388e-4** | **CRITICAL** |
| 03:46:29.9 | 6.335 | 7.66 | 1.8e-116 | MONITORING |
| 04:32:57.1 | 14.983 | 7.65 | 0.0 | MONITORING |
| 05:19:26.9 | 20.906 | 7.66 | 0.0 | MONITORING |

The designed encounter's TCA lands at exactly T0 + 10 800.0000 s. Its miss distance, 0.353547 km, is
6 mm off the designed √(0.35² + 0.05²) = 0.353553 km. Pc is computed with `ASSUMED_ILLUSTRATIVE`
covariance and a hard-body radius of 10 m. The combined encounter-plane sigmas are 285 m (major) and
134 m (minor).

**Agent run (deterministic).** Status `NEEDS_APPROVAL` in 7.5 s. Tool sequence and durations:

| Step | Tool | ms |
|---|---|---|
| 1 | list_conjunctions | 774 |
| 2 | get_conjunction_details | 0 |
| 3 | plan_maneuvers | 4 733 |
| 4–6 | check_secondary ×3 | 714 / 706 / 549 |
| 7 | generate_report | 1 |

All 10 validation checks passed (`VALID`).

**Planner.** It evaluated 120 candidates: 4 lead times × 6 directions × 5 magnitudes. 90 were feasible
and 30 met the target. All 30 rejections are the 2.0-orbit lead, whose burn time
(2026-10-16T23:54:03.555Z) falls before the window start. The primary's period is 5 578.2 s, so
2 orbits is longer than the 10 800 s from window start to TCA. The model-consistency baseline is
0.000 km at every lead, because both objects use the numerical model.

| Rank | ID | Burn | Lead | Burn time | Post miss (km) | Post Pc | J | Secondary |
|---|---|---|---|---|---|---|---|---|
| 1 | **MV-DEB-2047-066** | −T 0.05 m/s | 1.5 orb (8 367.3 s) | 00:40:32.666 | 1.4582 | 9.13e-10 | 0.05 | PASS |
| 4 | MV-DEB-2047-062 | +T 0.10 m/s | 1.5 orb | 00:40:32.666 | 1.8559 | 1.15e-13 | 0.10 | PASS |
| 20 | MV-DEB-2047-019 | −R 0.35 m/s | 0.5 orb (2 789.1 s) | 02:13:30.889 | 1.4247 | 4.78e-9 | 0.35 | PASS |

The recommendation is **MV-DEB-2047-066**. Approving it moved the session to **MITIGATED**, with a post
miss distance of 1.458 km.

**Selected grid points**, from re-reading the plan:

| Burn | Lead (orbits) | Post miss (km) | Post Pc | Meets target |
|---|---|---|---|---|
| −T 0.05 | 0.5 / 1.0 / 1.5 | 0.749 / 1.075 / 1.458 | 1.4e-5 / 1.03e-6 / 9.1e-10 | no / no / yes |
| +T 0.05 | 0.5 / 1.0 / 1.5 | **0.128** / 0.377 / 0.751 | **8.3e-4** / 5.2e-4 / 2.9e-5 | no |
| −R 0.35 | 0.5 / 1.0 / 1.5 | 1.425 / **0.356** / 1.423 | 4.8e-9 / 5.6e-4 / 5.0e-9 | yes / no / yes |
| ±N 0.50 | 0.5 / 1.0 / 1.5 | 0.346 – 0.361 at every lead | ≈ 5.6e-4 – 5.9e-4 | no |

No cross-track (±N) candidate met the target anywhere on the grid. The cheapest passing candidate in
each other direction:

| Direction | Cheapest passing |
|---|---|
| −T | 0.05 m/s @ 1.5 orb |
| +T | 0.1 m/s @ 1.0 orb |
| −R | 0.35 m/s @ 0.5 orb |
| +R | 0.5 m/s @ 0.5 orb |

Why these patterns appear is explained in [avoidance maneuvers](../concepts/avoidance-maneuvers.md#why-direction-and-lead-time-matter)
and [synthetic scenario](../scenarios/synthetic-conjunction.md#why-a-retrograde-burn-beats-a-prograde-one).

## Real scenario (`real-iss`)

The window ran from 2026-10-17T04:00Z to 2026-10-18T04:00Z, anchored at the ISS element epoch. The
catalog was 399 objects plus the ISS, and **399 of 399** passed the altitude filter (see
[real ISS](../scenarios/real-iss.md#numbers) for why). The run used 2 881 coarse samples, refined 96
local minima and found **12 conjunctions**. One object was co-orbital, there were no failures, and
screening took 0.37 s. No records were flagged STALE.

| Secondary | Miss (km) | Rel. speed (km/s) | TCA (UTC) | State |
|---|---|---|---|---|
| SUPERVIEW-1 03 | 6.711 | 7.33 | 10-17 21:51:24 | **UNVERIFIED** |
| STARLINK-2469 | 10.210 | 8.79 | 10-17 16:22:53 | MONITORING |
| HAWK-5C | 12.563 | 8.03 | 10-17 23:49:52 | MONITORING |
| ENSHI XIDA SHANQUAN | 13.868 | 7.60 | 10-18 02:29:08 | MONITORING |
| STARLINK-1225 | 16.875 | 2.54 | 10-17 22:27:04 | MONITORING |
| CTC-0 | 16.971 | 9.21 | 10-17 14:30:02 | MONITORING |
| 2024-199AK | 17.443 | 12.66 | 10-17 10:05:07 | MONITORING |
| LEMUR-2-NIMBUS2000 | 17.907 | 11.31 | 10-18 00:44:18 | MONITORING |
| STARLINK-2469 | 18.725 | 8.80 | 10-17 17:09:19 | MONITORING |
| ENSHI XIDA SHANQUAN | 20.404 | 7.58 | 10-18 03:15:40 | MONITORING |
| 2024-199AK | 20.612 | 12.68 | 10-17 10:51:34 | MONITORING |
| GHOST-5 | 24.767 | 6.56 | 10-17 04:22:29 | MONITORING |

Every Pc is `UNVERIFIED`, because public GP elements carry no covariance. The co-orbital exclusion was
**PROGRESS-MS 34**, a vehicle docked to the station.

## README claims vs measurement

| README claim | Measured | |
|---|---|---|
| Synthetic miss ≈ 354 m | 353.547 m | ✓ |
| Relative speed ≈ 7.7 km/s | 7.658 km/s | ✓ |
| Pc ≈ 5.7e-4 → CRITICAL | 5.7388e-4, CRITICAL | ✓ |
| Close approach three hours into the window | T0 + 10 800.000 s | ✓ |
| Agent calls `list → details → plan → check_secondary ×3 → report` | identical | ✓ |
| Three candidate burns, approval → MITIGATED | 3 candidates, MITIGATED | ✓ |
| Real data: "typically several 5–25 km passes within 24 h" | 12 passes, 6.7–24.8 km | ✓ |
| Docked vehicles excluded as co-orbital | PROGRESS-MS 34 excluded | ✓ |

## Not measured yet

- Planning on the real scenario, which would use the distance-based target because no Pc exists, and
  the SGP4-vs-J2 model difference for an SGP4 primary.
- The Gemini provider, because no API key was available.

Both are tracked in [open questions](open-questions.md).
