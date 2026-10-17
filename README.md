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
8. Runs a **perception layer**: an XGBoost risk ranker trained on CelesTrak-derived screening labels scores every catalog object from its orbital elements in milliseconds; the physics screening verifies the flagged objects and assigns the tiers shown in the view (CRITICAL / SEMI_CRITICAL / ML_WATCH). The model only ranks; every displayed distance and time is computed.
9. Visualises the emergency in a Waymo-style **encounter view** (Three.js): a chase camera behind the spacecraft, which is drawn with the same true-scale design model the globe uses (NASA's glTF for the ISS and GPM, part-built for other designs), a glowing path ribbon as wide as the satellite, blue boxes for the nearby semi-critical objects, red-outlined boxes for the critical ones with their relative-motion trails, and the path bending around the debris once a maneuver is selected or approved. Two geometries are available with a toggle: an *encounter map* (ahead = time to closest approach, sideways = true miss offset) and a *true-scale chase camera*. The CesiumJS globe stays available as a minimap that can be swapped to full size.
10. Requires explicit human approval before the simulated maneuver is applied.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + TypeScript, Vite 7, CesiumJS 1.146 (globe), Three.js 0.186 (encounter view), Tailwind CSS 4, Recharts 3, Zustand |
| Backend | Python 3.12, FastAPI, Pydantic 2, NumPy, SciPy, `sgp4`, `xgboost` 3.4 (+ scikit-learn twin), `google-genai` |
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
scripts/enable_xgboost_macos.sh         # macOS without Homebrew only: lets the xgboost wheel find an OpenMP runtime
.venv/bin/uvicorn app.main:app --reload --port 8000
```

The PyPI `xgboost` wheel for macOS links against `libomp.dylib` but does not ship it. The script above adds a
loader-relative search path so it reuses the copy bundled with scikit-learn (no Homebrew needed); `brew install libomp`
works too. If xgboost still cannot import, the backend automatically uses the scikit-learn twin of the model, and if no
model loads at all the perception layer runs physics-only and says so in every response.

API docs: <http://localhost:8000/docs>. Health: <http://localhost:8000/api/health>.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev          # copies Cesium's static assets (public/cesium) and Three's Draco decoder (public/draco), starts Vite on :5173
```

Open <http://localhost:5173> for the catalog explorer: every tracked object on orbit, propagated live
with SGP4 in a browser worker, with type, orbit class and operator filters and a details card on click.
The collision avoidance simulator is at <http://localhost:5173/mission>. The backend URL defaults to
`http://localhost:8000` (override with `VITE_API_BASE_URL` in `frontend/.env.local`).

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
| `VITE_CESIUM_ION_TOKEN` | empty | Optional Cesium ion token for photographic world imagery on the simulator's globe. Without it the globe is the same vector-drawn Earth as the home page (Natural Earth coastlines via world-atlas, offline). |

Screening/risk thresholds (`SCREENING_RADIUS_KM`, `PC_CRITICAL_THRESHOLD`, `PC_MITIGATION_TARGET`,
`MISS_DISTANCE_TARGET_KM`, planner grid, …) are configurable in [`backend/app/config.py`](backend/app/config.py)
and via environment variables of the same name. They are **demonstration settings, not safety standards**.

### 4. Tests

```bash
cd backend && .venv/bin/python -m pytest          # physics, API and agent tests
cd frontend && npm test                            # simulation controller + Hermite interpolation
cd frontend && npm run typecheck && npm run build  # type gate + production build
```

### 5. Retrain the perception model (optional)

```bash
cd backend && .venv/bin/python scripts/train_perception_model.py --primaries 150 --max-candidates 3000 --workers 6
```

Downloads the CelesTrak groups when `data/cache` is empty, samples 150 LEO payloads stratified by altitude and
inclination, labels every candidate pair with the physics screening (24 h, 30 s coarse step, 1 s refinement), trains
XGBoost and a scikit-learn twin and writes `data/models/perception_risk.*` plus a training report. The committed model
was trained on 409,792 pairs (2,357 within 25 km, 91 within 5 km) in about a minute: test ROC-AUC 0.966, and the
operating threshold keeps 100 % of the critical pairs while flagging 21 % of the candidates.

## Demo walkthrough (Scenario B — scripted conjunction)

1. Start both servers and open <http://localhost:5173/mission>. The synthetic scenario loads on the **globe**, the camera following the spacecraft up close, with the **encounter map** as the minimap at the bottom left (⤢ or **Show encounter** swaps the two): the primary is a synthetic-state stand-in for NASA's **GPM Core Observatory** (407 km, 65°, the orbit GPM flies and maintains with its hydrazine thrusters) plus a debris object on a crossing orbit and a few background objects. Press **Play** (or space). The camera follows the spacecraft from close enough to see its true-scale 3D model, riding its teal path band; drag to orbit around it and scroll out for orbit context (**Reset** returns to the default framing). In the encounter map the spacecraft sits at the bottom of a dark "road" whose lanes are km of miss offset and whose length is time to each object's closest approach; the glowing ribbon is its planned path. Each object's design and L × W × H envelope (published for the ISS and GPM, scenario-defined for the synthetic debris, otherwise sized from the hard-body radius) appear in the object inspector. The ISS and GPM use NASA's public 3D models (NASA 3D Resources; credits in [`frontend/public/models/README.md`](frontend/public/models/README.md)), prepared by [`frontend/scripts/prepare_models.py`](frontend/scripts/prepare_models.py); other spacecraft are built procedurally.
2. Click **Screen conjunctions** (or go straight to **Analyze with agent**). The physics engine finds the designed close approach three hours into the window: miss distance ≈ 354 m, relative speed ≈ 8.2 km/s, Pc ≈ 5.7e-4 with the scenario's *illustrative* covariances → state **CRITICAL**. On the globe, the red marker, danger region and miss vector appear at the predicted TCA; the timeline shows a TCA tick and a countdown. In the encounter map, the perception layer scores the catalog and the critical debris appears far up the road as a red-outlined box with its relative-motion trail; its later, farther passes show up as blue boxes only when they enter the 30-minute near field. Scrub to T−10 min and T−60 s to watch it slide onto the ribbon.
3. Click **Analyze with agent**. The agent calls `list_conjunctions → get_conjunction_details → plan_maneuvers → check_secondary ×3 → generate_report`; the tool execution history, validation checks and narrative appear in the panel. Three candidate burns are drawn in green; the recommended one is highlighted.
4. Compare candidates in the table and chart (Δv, post-burn miss distance, post-burn Pc, target met, secondary screening status). Click a row or a green path to select it; **Jump to burn** moves the clock to the burn.
5. Click **Approve simulated maneuver**. The backend validates the candidate (feasible, meets the target, secondary screening passed), records the decision, and the state becomes **MITIGATED**. The teal path band continues along the maneuvered trajectory while the original stays dashed cyan for comparison. **Reject** restores the original. **Reset** returns the scenario to the identical initial state.

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
* **Perception layer** (`backend/app/perception/`). Pairwise features from mean elements only (plane angle, radial separation at the mutual nodes, band overlap, synodic period, phase, epoch age, B*, category); an XGBoost classifier (scikit-learn twin as fallback, null model as last resort) scores every object; `perceive()` physics-screens the altitude band (or, above 1,500 objects, the model's top-K plus the near band), assigns tiers (CRITICAL = threat state CRITICAL/ELEVATED, or miss < 5 km when no probability exists; SEMI_CRITICAL = inside the 25 km screening radius; ML_WATCH = high score but physics-cleared), and returns RTN miss vectors, co-moving relative velocities and ±90 s relative-motion trails along the original, a candidate, or the approved trajectory. Cached per session and invalidated on screening, approval and rejection.
* **Encounter view** (`frontend/src/encounter/`). Pure, unit-tested projection math (`encounterMap.ts`, `ribbon.ts`, `rtn.ts`) feeds a Three.js scene manager. Map mode: ahead = time to closest approach (linear to 10 min, logarithmic to the ≥ 2-orbit horizon), sideways = the miss offset in the encounter plane (linear to 3 km, logarithmic to the 25 km road edge), ribbon width = spacecraft width = 1 km; the ribbon bends by the lateral RTN displacement between the maneuvered and original trajectories. Chase mode: true relative positions inside 100 km, spacecraft ×10, boxes 250 m. The legend states every schematic scale; printed numbers come from the backend.
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
| `GET /api/perception?scenario_id=&maneuver_id=&horizon_s=&critical_radius_km=&tracked_radius_km=&include_hidden=` | ML-ranked, physics-verified objects around the primary with tiers, RTN miss vectors and trails |
| `GET /api/perception/model` | Loaded model, metrics, threshold and training provenance |
| `GET /api/simulation/state` | Threat state, approvals, decisions |
| `POST /api/simulation/approve`, `POST /api/simulation/reject` | Human decision on a simulated maneuver |
| `POST /api/data/refresh` | Download fresh CelesTrak groups (network required) |
| `GET /api/catalog` | Explorer catalog: every on-orbit object's TLE with SATCAT type, owner and launch date, plus orbit class |
| `POST /api/catalog/refresh` | Rebuild the explorer catalog from CelesTrak (`GROUP=active`, `NAME=DEB`, `NAME=R/B`, SATCAT); at most once every 2 hours |

## Repository layout

```
.
├── README.md · .env.example
├── backend/
│   ├── app/{api,schemas,data,physics,perception,agent,scenarios,simulation}/
│   ├── scripts/build_real_fixture.py     # rebuilds data/scenarios/real_catalog.tle from downloaded groups
│   ├── scripts/train_perception_model.py # labels CelesTrak pairs with the physics screening and trains the ranker
│   ├── scripts/enable_xgboost_macos.sh   # pip-only OpenMP fix for the xgboost wheel on macOS
│   └── tests/                            # pytest suite (physics, API, agent)
├── frontend/src/{api,components,encounter,globe,hooks,lib,panels,simulation,store,types}/
└── data/
    ├── cache/                            # downloaded CelesTrak groups (git-ignored)
    ├── models/perception_risk.*          # trained XGBoost + scikit-learn artifacts, metadata, training report
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
* The perception model is a ranker trained on one CelesTrak snapshot (2026-10-17) with labels from our own screening; its scores are estimates, never displayed as distances, and it should be retrained after `POST /api/data/refresh` when the snapshot ages. Objects it flags are always verified by the physics screening before they are tiered.
* The encounter map is a schematic projection (nonlinear time and lateral scales, enlarged objects); the chase camera is true scale apart from the spacecraft model, which is enlarged by the factor its legend states, but, at orbital speeds, an object crosses the 100 km view in about 13 s of simulation time.

## Data attribution

Orbital elements from [CelesTrak](https://celestrak.org/) (GP data, groups `stations`, `active`,
`cosmos-2251-debris`, `iridium-33-debris`, `fengyun-1c-debris`); retrieval time and filter are recorded in
`data/scenarios/real_catalog.meta.json`. Earth: coastlines from Natural Earth (world-atlas 50 m) drawn into a texture at run time; Cesium ion world imagery when a token is configured.
