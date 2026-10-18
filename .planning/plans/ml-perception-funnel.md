# Plan: ML perception funnel on the real ISS scenario

Spec: `.planning/specs/ml-perception-funnel.md`
Workspace: the shared main working tree (the user's choice; two peer sessions have uncommitted work in the same
files). Backend saves are batched and announced to aegis-orbit-49 / aegis-orbit-79 because their dev backend runs
with `--reload`. Browser checks run against my own backend (:8010) and Vite (:5180).
Commits: none until the user decides. My hunks in shared files sit on top of the peers' uncommitted code, so a commit
of only my hunks would not build on its own.

## Backend (one save batch, then tests)

### Task 1: full catalog fixture
Files: `backend/scripts/build_real_fixture.py` (`--full`), `data/scenarios/real_catalog_full.tle.gz` + `.meta.json`,
`backend/app/scenarios/real.py` (`load_full_catalog`), `backend/app/scenarios/registry.py` (`build_real` only).
Test first: `tests/test_real_full.py`: the full catalog loads with 18,599 objects including the ISS, ISS modules are
excluded, provenance is set; `build_real()` uses it.

### Task 2: fixed screening shortlist
Files: `backend/app/perception/perception.py` (`screening_shortlist`, `perceive` uses the scenario shortlist,
`counts.ml_flagged`, `funnel`), `backend/app/scenarios/registry.py` (Scenario fields), `backend/app/simulation/service.py`
(`_screening_objects` in `run_screening` + `run_secondary_check`; stats `catalog_total`, `shortlist`),
`backend/app/schemas/models.py` (optional fields).
Test first: the shortlist contains every object a brute-force band screen finds within 25 km; existing stats keys
are present; the secondary check screens the same set.

### Task 3: API: bounded objects, cloud TLEs, drill
Files: new `backend/app/simulation/drill.py`, `backend/app/simulation/service.py` (`list_objects` cap),
`backend/app/api/routes.py` (two routes), `backend/app/schemas/models.py`.
Test first: `tests/test_drill.py`: objects endpoint bounded; catalog-tles row count; drill → screening finds DRILL-1
< 1 km → perception CRITICAL → plan → candidate meets target → secondary passes → approve OK → reset removes it;
409 on a second drill or another scenario. Update `test_api.py`'s real-scenario object-count assertion only.

## Frontend

### Task 4: types, API client, perception store, funnel logic
Files: `frontend/src/types/api.ts`, `frontend/src/api/client.ts`, new `frontend/src/perception/{funnel.ts,store.ts}`.
Test first: `funnel.test.ts`: stage membership/colour per object, step counts from a perception response,
the decision verdict (stay / alert).

### Task 5: catalog cloud
Files: new `frontend/src/perception/{cloud.worker.ts,catalogCloud.ts}`, one-line hook in `frontend/src/globe/scene.ts`,
an effect in `frontend/src/globe/GlobeView.tsx` (main view only).
Test first: `catalogCloud.test.ts` for the pure parts (stage → colour/alpha, extrapolation between worker ticks).

### Task 6: ML perception section + operator decision card
Files: new `frontend/src/perception/PerceptionSection.tsx`, one-line hook in `frontend/src/panels/MissionPanel.tsx`,
`ThreatSection` catalog-total wording, README section.
Test first: render test of the decision card for the stay and alert verdicts.

### Task 7: verify
`pytest` (full), `npm test`, `npm run typecheck`, `npm run build`, a Playwright run of the whole flow on :5180/:8010,
then the review agent (Stage 5).
