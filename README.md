# Aegis Orbit — Autonomous Orbital Collision Avoidance Simulator

An interactive, AI-assisted collision-avoidance simulator for satellites: **predict, plan, avoid, explain**.
A Python physics engine propagates real and synthetic orbits, screens for close approaches, estimates
collision probability with explicit uncertainty labels, plans candidate avoidance burns and screens them
for secondary risks. A Gemini-powered agent orchestrates those tools and explains its recommendation; a
human approves or rejects the *simulated* maneuver in a Waymo-style 3D visualisation of the orbital
environment.

> **Research and simulation prototype.** Positions are SGP4 estimates from public mean elements or
> synthetic states, not sensor telemetry. Nothing here is flight software and no spacecraft is commanded.

## What it does

1. Loads public orbital data (CelesTrak GP/TLE records, cached and committed as a fixture) and a deterministic synthetic scenario.
2. Propagates trajectories (SGP4 for catalog objects; two-body + J2 RK4 for synthetic states and post-burn arcs).
3. Screens the primary against the catalog for close approaches (coarse filter → batch propagation → local minima → bounded refinement → dedup → ranking).
4. Computes collision probability with the 2-D encounter-plane (Foster) method **only when covariance inputs exist**; otherwise reports `UNVERIFIED`.
5. Plans candidate maneuvers with a documented grid search and objective (delta-v cost vs. risk reduction).
6. Re-screens every candidate's post-burn trajectory against the catalog (secondary screening).
7. Runs a Gemini tool-calling agent (or a deterministic fallback when no key is set) that explains the threat, the assessment, the candidates, the secondary risks and the uncertainties — every number comes from a backend tool result and the final recommendation is validated against the tool outputs.
8. Visualises everything in CesiumJS: Earth with atmosphere, the spacecraft, tracked objects, dashed predicted paths, the predicted closest-approach point and danger region, candidate burns, and the approved maneuvered trajectory next to the original.
9. Requires explicit human approval before the simulated maneuver is applied.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + TypeScript, Vite 7, CesiumJS 1.146, Tailwind CSS 4, Recharts 3, Zustand |
| Backend | Python 3.12, FastAPI, Pydantic 2, NumPy, SciPy, `sgp4`, `google-genai` |
| Data | CelesTrak GP data (committed fixture + optional live refresh), deterministic synthetic scenario |
| AI | Google Gemini function calling (key stays in the backend); deterministic fallback agent |

## Quick start

Prerequisites: Node 22+, Python 3.12 (3.10+ works). On this machine Python 3.12 was installed with
[`uv`](https://docs.astral.sh/uv/) (`uv python install 3.12`); a plain `python3.12 -m venv` works too.

### 1. Backend

```bash
cd backend
uv venv .venv --python 3.12            # or: python3.12 -m venv .venv
uv pip install --python .venv/bin/python -r requirements.txt   # or: .venv/bin/pip install -r requirements.txt
cp ../.env.example .env                 # optional: add GEMINI_API_KEY
.venv/bin/uvicorn app.main:app --reload --port 8000
```

API docs: <http://localhost:8000/docs>. Health: <http://localhost:8000/api/health>.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev          # copies Cesium's static assets to public/cesium and starts Vite on :5173
```

Open <http://localhost:5173>. The backend URL defaults to `http://localhost:8000`
(override with `VITE_API_BASE_URL` in `frontend/.env.local`).

### 3. Environment variables

See [`.env.example`](.env.example). Backend variables are read from `.env` in the repo root or in `backend/`.

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | empty | Enables the Gemini agent. Never sent to the browser. Empty → deterministic fallback agent. |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model used for tool calling. |
| `AGENT_MODE` | `auto` | `auto` (Gemini if a key exists), `gemini`, or `deterministic`. |
| `ALLOW_NETWORK` | `true` | Set `false` for fully offline use (CelesTrak refresh disabled). |
| `DATA_CACHE_DIR` | `data/cache` | Where downloaded CelesTrak groups are cached (git-ignored). |
| `CORS_ORIGINS` | Vite dev origins | Allowed browser origins. |
| `VITE_API_BASE_URL` | `http://localhost:8000` | Frontend → backend base URL. |
| `VITE_CESIUM_ION_TOKEN` | empty | Optional Cesium ion token for world imagery. Without it the bundled offline Natural Earth II imagery is used. |

Screening/risk thresholds (`SCREENING_RADIUS_KM`, `PC_CRITICAL_THRESHOLD`, `PC_MITIGATION_TARGET`,
`MISS_DISTANCE_TARGET_KM`, planner grid, …) are configurable in [`backend/app/config.py`](backend/app/config.py)
and via environment variables of the same name. They are **demonstration settings, not safety standards**.

### 4. Tests

```bash
cd backend && .venv/bin/python -m pytest          # physics, API and agent tests
cd frontend && npm test                            # simulation controller + Hermite interpolation
cd frontend && npm run typecheck && npm run build  # type gate + production build
```

## Demo walkthrough (Scenario B — scripted conjunction)

1. Start both servers and open the app. The synthetic scenario loads: primary **AEGIS-1** (420 km, 51.6°) plus a debris object on a crossing orbit and a few background objects. Press **Play** (or space) and watch the camera follow the spacecraft; dashed cyan is its predicted path. Press **Close-up** to frame its true-scale 3D model; each object's design and L × W × H envelope (published for the ISS, scenario-defined for AEGIS-1, otherwise sized from the hard-body radius) appear in the object inspector. The ISS uses NASA's public 3D model (NASA 3D Resources, credit NASA/Michael D. Carbajal), prepared by [`frontend/scripts/prepare_iss_model.py`](frontend/scripts/prepare_iss_model.py); other spacecraft are built procedurally.
2. Click **Screen conjunctions** (or go straight to **Analyze with agent**). The physics engine finds the designed close approach three hours into the window: miss distance ≈ 354 m, relative speed ≈ 7.7 km/s, Pc ≈ 5.7e-4 with the scenario's *illustrative* covariances → state **CRITICAL**. The red marker, danger region and miss vector appear at the predicted TCA; the timeline shows a TCA tick and a countdown.
3. Click **Analyze with agent**. The agent calls `list_conjunctions → get_conjunction_details → plan_maneuvers → check_secondary ×3 → generate_report`; the tool execution history, validation checks and narrative appear in the panel. Three candidate burns are drawn in green; the recommended one is highlighted.
4. Compare candidates in the table and chart (Δv, post-burn miss distance, post-burn Pc, target met, secondary screening status). Click a row or a green path to select it; **Jump to burn** moves the clock to the burn.
5. Click **Approve simulated maneuver**. The backend validates the candidate (feasible, meets the target, secondary screening passed), records the decision, and the state becomes **MITIGATED**. The maneuvered trajectory becomes solid green while the original stays dashed cyan for comparison. **Reject** restores the original. **Reset** returns the scenario to the identical initial state.

### Scenario A — real GP data

ISS (NORAD 25544) screened against 399 cached CelesTrak objects whose altitude band overlaps the station's.
No conjunction is fabricated: the screening reports whatever it finds (typically several 5–25 km passes
within 24 h). Because public elements carry no covariance, probabilities are reported as **UNVERIFIED**
and states are `MONITORING`/`UNVERIFIED`; the optional *illustrative covariance* re-screen is clearly labelled.
Docked vehicles sharing the station's elements are excluded as co-orbital. Use `POST /api/data/refresh`
(or `POST /api/scenarios/real-iss/reset?live=true`) to download fresh elements when online.

## Architecture

```
frontend/ (React + Cesium)                    backend/ (FastAPI)
┌───────────────────────────┐   REST/JSON    ┌───────────────────────────────────────────┐
│ simulation controller     │ ─────────────▶ │ api/routes ── simulation/service ── session│
│  (clock, Hermite sampling)│                │        │                │                  │
│ globe/scene (entities,    │ ◀───────────── │ agent/orchestrator ──▶ agent/tools         │
│  TEME→fixed per frame)    │   trajectories │   (Gemini | deterministic)   │             │
│ panels (threat, agent,    │   conjunctions │                              ▼             │
│  candidates, decision)    │   maneuvers    │ physics/: propagation · screening ·        │
└───────────────────────────┘   agent runs   │   collision_probability · maneuver_planner │
                                             │   · secondary_screening · threat            │
                                             │ data/: tle · celestrak · catalog           │
                                             │ scenarios/: synthetic · real · registry     │
                                             └───────────────────────────────────────────┘
```

* **Frames and units.** Every backend state is TEME (SGP4's native frame), km and km/s; delta-v in m/s; times ISO 8601 UTC. The frontend rotates TEME to Cesium's Earth-fixed frame every frame with Cesium's GMST-based `computeTemeToPseudoFixedMatrix`.
* **Simulation controller.** The browser keeps one clock; trajectories are precomputed on the backend at 60–120 s and interpolated with cubic Hermite (position + velocity) — sub-metre accuracy, no per-frame backend calls, and the animation never invents states.
* **Propagation models.** SGP4 for GP records; two-body + J2 RK4 (10 s step, exact landing on requested times, forward and backward) for synthetic states and post-burn arcs. The planner reports the difference between the two models for the un-maneuvered primary at each burn lead time (`baseline` / "model consistency").
* **Screening.** Perigee/apogee band overlap filter (never instantaneous altitude) → batch SGP4 (`SatrecArray`) → sample-level local minima of the relative distance → bounded Brent refinement of the exact distance (1 ms tolerance) → co-orbital rejection (relative speed < 10 m/s) → dedup → ranking by miss distance.
* **Collision probability.** Foster 2-D encounter-plane integration (Gauss–Legendre × trapezoid), validated against the closed-form isotropic solution to 1e-9. Covariance basis is always labelled `PROVIDED`, `ASSUMED_ILLUSTRATIVE`, `MIXED` or `UNAVAILABLE`; hard-body radius is an explicit input with its own basis label.
* **Threat states** (backend rules only): `NORMAL`, `MONITORING`, `ELEVATED` (Pc ≥ 1e-5), `CRITICAL` (Pc ≥ 1e-4), `MITIGATED` (approved maneuver meets the configured target and secondary screening passes), `UNVERIFIED` (miss < 10 km but no covariance).
* **Maneuver planner.** Grid of lead times (0.5–2 orbits) × RTN directions × magnitudes (0.05–0.5 m/s), impulsive burns, objective `J = |Δv|/budget + max(0, log10(Pc_post/Pc_target)) [+ distance shortfall when Pc is unavailable] + penalty if infeasible`; diverse top-3 recommendation. Covariance is assumed unchanged by the burn (documented).
* **Secondary screening.** The post-burn primary is screened against the whole catalog from the burn time to the window end; new approaches, changed miss distances and completeness are reported. A maneuver is never declared safe just because it clears the original object.
* **Agent integrity.** The LLM only chooses tools and writes prose. `generate_report` fills every numeric field from session records; `validate_report` checks that the recommended maneuver exists, is feasible, meets the target, belongs to the reported threat and passed secondary screening. Tool calls are logged with inputs, status, duration and a summary.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Service status, agent mode, scenario list |
| `GET /api/scenarios`, `GET /api/scenarios/{id}` | Scenario summaries / detail (window, data source, thresholds, simulation state) |
| `POST /api/scenarios/{id}/reset?live=false` | Reset to the initial state (`live=true` rebuilds the real scenario from a fresh download) |
| `GET /api/objects?scenario_id=` | Catalog with provenance and uncertainty metadata |
| `GET /api/objects/{id}?scenario_id=&at=` | Object detail with state (TEME, geodetic, osculating elements) at a time |
| `GET /api/objects/{id}/trajectory?scenario_id=&start=&end=&step_s=&maneuver_id=` | Trajectory samples; with `maneuver_id`, the post-burn arc from the burn time |
| `POST /api/objects/trajectories` | Batch trajectories |
| `POST /api/conjunctions/screen` | Screen the primary (`pc_policy`: `provided_only` \| `illustrative_default`) |
| `GET /api/conjunctions?scenario_id=`, `GET /api/conjunctions/{id}` | Current screening results / full conjunction record |
| `POST /api/conjunctions/{id}/maneuvers`, `GET …/maneuvers` | Plan candidates / fetch the existing plan |
| `POST /api/maneuvers/{id}/secondary-check` | Secondary screening for a candidate |
| `POST /api/agent/analyze` | Run the agent (`mode`: `auto` \| `gemini` \| `deterministic`) |
| `GET /api/simulation/state` | Threat state, approvals, decisions |
| `POST /api/simulation/approve`, `POST /api/simulation/reject` | Human decision on a simulated maneuver |
| `POST /api/data/refresh` | Download fresh CelesTrak groups (network required) |

## Repository layout

```
.
├── README.md · .env.example
├── backend/
│   ├── app/{api,schemas,data,physics,agent,scenarios,simulation}/
│   ├── scripts/build_real_fixture.py     # rebuilds data/scenarios/real_catalog.tle from downloaded groups
│   └── tests/                            # pytest suite (physics, API, agent)
├── frontend/src/{api,components,globe,hooks,lib,panels,simulation,store,types}/
└── data/
    ├── cache/                            # downloaded CelesTrak groups (git-ignored)
    └── scenarios/real_catalog.{tle,meta.json}   # committed fixture + provenance
```

## Known limitations

* Public GP elements have no covariance; real-data probabilities are `UNVERIFIED` unless the clearly labelled illustrative policy is chosen. The synthetic scenario's covariances are scenario definitions.
* SGP4 accuracy degrades with age from each element epoch (km-level after a day); the committed fixture ages, and the real scenario's window is anchored at the ISS element epoch for that reason. Records older than 30 days are flagged `STALE`.
* The numerical model is two-body + J2 only (no drag, no higher harmonics); the post-burn arc is therefore an approximation and the baseline model difference is reported rather than hidden.
* Screening uses a 30 s coarse step; minima narrower than the step that sit next to another minimum could merge. The catalog is a hackathon-sized subset (400 objects near the ISS band), so secondary screening is explicitly `LIMITED` to it.
* The planner is a deterministic grid search, not an optimiser; the delta-v budget is a proxy, and maneuver execution errors are not modelled.
* No public conjunction-message feed (e.g. SOCRATES/CDMs) is integrated; all conjunctions come from the local screening.
* Single-user in-memory sessions; restarting the backend clears screenings, plans and decisions (the scenario definitions are deterministic and reload identically).
* The Gemini path needs network access and a key; the deterministic fallback keeps the whole demo working offline.

## Data attribution

Orbital elements from [CelesTrak](https://celestrak.org/) (GP data, groups `stations`, `active`,
`cosmos-2251-debris`, `iridium-33-debris`, `fengyun-1c-debris`); retrieval time and filter are recorded in
`data/scenarios/real_catalog.meta.json`. Earth imagery: Natural Earth II (bundled with CesiumJS).
