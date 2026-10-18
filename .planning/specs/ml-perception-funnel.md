# Spec: ML perception funnel on the real ISS scenario

Date: 2026-10-17 · Status: draft (Gate 1) · Stack: full-stack (FastAPI + React/Cesium)

## Pain
The project's core idea is "the ML model ranks, physics verifies, a human decides", but nobody can see it.
The ISS scenario ships with 400 objects, below the 1,500-object full-screen limit, so `perceive()` physics-screens
everything and the model never filters anything. No frontend view calls `/api/perception` at all.

## Narrowest version
Only the real ISS scenario (`real-iss`, `kind === 'real'`). The Home explorer, the scripted GPM scenario and the
sandbox are unchanged.

## Measured baseline (today's cache, retrieved 2026-10-17 15:59 UTC)
- 18,604 records in the five CelesTrak groups (stations, active, cosmos-2251-debris, iridium-33-debris,
  fengyun-1c-debris); 18,598 objects besides the ISS after excluding ISS modules.
- ML scores all of them in 0.05 s; 286 are at or above the operating threshold (0.0236).
- ML-prioritised screening: model top 300 + 268 objects within 10 km of the ISS altitude band = 374 objects, 0.4 s.
- Brute force over the 6,754 objects in the ±50 km altitude band: 7.2 s. Both find the same 13 passes within 25 km
  (10 objects); every one is at ML rank ≤ 116. Closest: SUPERVIEW-1 03 at 6.71 km (UNVERIFIED, no covariance).
- Full object summaries are 18.8 MB of JSON; a compact TLE list is 3.6 MB (1.1 MB gzipped).

## IN
### Backend
1. **Full catalog.** Commit a gzipped snapshot of the five groups (`data/scenarios/real_catalog_full.tle.gz` + meta)
   built from the same 2026-10-17 download as the 400-object fixture. `build_real()` loads it when present and falls
   back to the 400-object fixture otherwise. `load_fixture_catalog()` (400) stays as it is for the dataset tests.
   `live=true` refresh behaviour is unchanged.
2. **Fixed screening shortlist** for catalogs above `perception_full_screen_max_objects`: computed once per scenario
   build from the original ISS: model top `perception_screen_top_k` + every object within
   `perception_guaranteed_band_margin_km` of the ISS band (+ the drill object when injected). `run_screening`,
   `run_secondary_check` and `perceive` all screen this same set, so baseline and post-burn screens compare like with
   like. Screening stats keep every existing key and add `catalog_total` and `shortlist`.
3. **Bounded object list.** `/api/objects` for a shortlisted scenario returns primary + rendered + shortlist objects
   (≈ 450) and `catalog_total`, not 18.6k summaries.
4. **Cloud data.** `GET /api/scenarios/{id}/catalog-tles` returns compact rows `[object_id, name, category, line1, line2]`
   for every SGP4 object (gzip middleware already on).
5. **Perception additions.** `counts.ml_flagged` (true count at the threshold, not capped at 50) and a `funnel` block:
   `flagged_ids`, `screened_ids`, shortlist composition (top-K, band margin, sizes).
6. **Drill threat.** `POST /api/scenarios/{id}/drill` (real scenario only, one drill per session, 409 otherwise):
   injects `DRILL-1 (injected test threat)`, a two-body + J2 object defined at its closest approach
   (TCA = now + 2.25 ISS orbits, 0.35 km miss, 65° crossing) and back-propagated to `now`, the same construction as
   the sandbox junk. Labelled `source=drill`, `position_basis=DRILL_INJECTED`; added to the shortlist and the rendered
   set; perception and screening are invalidated. Reset removes it.

### Frontend (gated on `scenario.kind === 'real'`)
7. **Catalog cloud.** All ~18.6k objects drawn as small points on the globe, propagated with SGP4 in a web worker at
   the simulation clock, coloured by funnel stage. A separate overlay module with a one-line hook in `scene.ts`.
8. **ML perception section** at the top of the mission panel: "Run ML perception" plays the funnel step by step,
   with the cloud fading in sync:
   tracked 18,598 → flagged by the model 286 → checked with physics 374 → confirmed within 25 km 13 → critical 0.
9. **Operator decision card.**
   - No critical pass: "Recommendation: stay on course", closest pass and why (outside the 5 km target),
     an Acknowledge button, and a "Run drill" button.
   - Critical pass (the drill): an alert with object, miss distance and time to TCA; "Plan avoidance maneuver"
     (the existing plan → candidates → Human decision approve/reject flow) or "Stay on course" (acknowledged in the
     panel).
   - The drill is badged DRILL wherever it appears.

## OUT
- Home explorer, GPM scripted scenario, sandbox: no changes.
- Picking cloud points (no inspector for cloud dots).
- Persisting "stay on course" on the backend.
- Live CelesTrak refresh of the full catalog.
- Any onboard-sensor modelling: the panel says the catalog comes from ground tracking.

## Acceptance criteria
- Loading `real-iss` shows ~18.6k cloud points and the ISS; `/api/objects` stays under ~1 MB.
- Running perception shows the five funnel counts from the backend response (no hard-coded numbers) and takes
  < 2 s of backend time.
- Screening the real scenario finds the same passes as a brute-force screen of the altitude band (test).
- Without a drill the decision card recommends staying on course. After "Run drill", DRILL-1 is CRITICAL, the planner
  returns a candidate that meets the 5 km target and passes secondary screening, and approval succeeds.
- `test_sandbox.py`, `test_commit_api.py`, `test_piecewise.py`, Scenario B tests and the full suites stay green;
  `npm test`, `npm run typecheck`, `npm run build` pass.

## Risks
- **Browser performance:** 18.6k points updated per frame. The explorer already draws 25k at 1 Hz SGP4 + per-frame
  velocity extrapolation; reuse that approach.
- **Honesty:** a synthetic object in a real-data scenario. It must be labelled as a drill in its name, badge, panel and
  disclaimers.
- **Shortlist recall on future data:** verified 13/13 today; the 10 km band is the safety net and the stats/limitations
  say which set was screened.
- **No ISS covariance:** the drill's Pc is UNVERIFIED, so the planner uses the 5 km distance target. Verify approval
  validation passes on that basis.
