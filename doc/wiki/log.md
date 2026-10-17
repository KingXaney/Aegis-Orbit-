# Log

The wiki's history in chronological order, append-only. Each entry starts with
`## [YYYY-MM-DD] <op> | <subject>`, where `<op>` is one of ingest, query, lint or schema. To list the
latest five entries, run `grep "^## \[" doc/wiki/log.md | tail -5`.

## [2026-10-17] schema | Wiki created

- Set up `doc/` following Karpathy's LLM Wiki pattern: `raw/` (immutable sources), `wiki/`
  (agent-maintained) and `CLAUDE.md` (the schema).
- Conventions chosen:
  - relative markdown links instead of wikilinks, so pages render on GitHub, in VS Code and in Obsidian
  - clickable code citations pinned to the commit of a codebase source page
  - *(background)* markers on claims not backed by an ingested source
  - measured numbers only via analysis pages
- Page types: overview, source, concept, component, scenario, analysis.

## [2026-10-17] ingest | Aegis Orbit codebase @ a34844b

- Read the backend in full (physics, data, scenarios, agent, simulation, API), the core frontend
  modules (clock, Hermite interpolation, frames; scene and store in part), the README, config and key
  tests. The frontend panels were not read.
- Created: `sources/codebase-a34844b.md`, `overview.md`, 10 concept pages, 7 component pages and
  2 scenario pages.
- Takeaways: the backend owns every number, uncertainty is labelled rather than hidden, the two
  propagation models are never silently swapped, safety is checked twice (target plus secondary
  screening), and the demo is deterministic.

## [2026-10-17] query | Baseline pipeline run: what do the scenarios actually produce?

- Ran the deterministic agent end to end on `synthetic-conjunction` and screened `real-iss` at
  a34844b. Then re-read individual planner grid points to test a relative-motion explanation.
- Filed `analyses/2026-10-17-baseline-pipeline-run.md`.
- Every quantitative claim in the README held.
- New findings:
  - the synthetic debris yields 7 conjunctions, not 1
  - real-iss yields 12 passes, with the closest UNVERIFIED at 6.7 km
  - no cross-track burn ever meets the target on the default grid
  - linear CW relative motion predicts the planner's miss distances to within 3 m
- Explanation added to `concepts/avoidance-maneuvers.md` and `scenarios/synthetic-conjunction.md`.

## [2026-10-17] lint | Initial pass

- Mechanical check, with a scratch script outside the repo:
  - 25 wiki pages and 196 code citations
  - every relative link and heading anchor resolves
  - every cited line range is inside its file
  - no orphans, and every page is in `index.md`
- Manual spot check of all cited lines against their claims. Three were misaligned and are fixed:
  `build_real_fixture.py` L25→L24 and L46-59→L46-60, `scene.ts` L117-136→L119-137 and
  `orchestrator.py` L138-139→L137-138.
- Filed `analyses/open-questions.md`:
  - **one possible bug**: `LIMITED` masks `FAIL` in secondary screening
  - design questions: the grid excludes ±N by construction, the prose is unvalidated, tool errors are
    non-gating, there is no dilution warning
  - unmeasured: live Gemini, the planner on real-iss, the frontend panels
  - six suggested raw sources
- No code was changed.
