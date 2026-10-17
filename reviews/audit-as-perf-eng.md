# Performance Audit: Home page redesign (catalog explorer)

**Perspective**: Performance Engineer
**Date**: 2026-10-17
**Plan**: ~/.claude/plans/pasted-content-id-60c7-goal-hidden-lovelace.md (implemented)

## Plan Summary
Catalog grows from 12,658 to 28,189 objects; a backend screening of GPM against all of them (~15 s) runs on a background thread; Earth texture moves to a worker; bundles are split.

## Files Reviewed
| File | Performance Role | Risk |
|------|-----------------|------|
| backend/app/simulation/explorer_screening.py | 15 s CPU job, cached | Medium |
| backend/app/api/routes.py | Catalog ETag/304, approaches 202 | Low |
| frontend/src/explorer/earthTexture*.ts | Texture off main thread | Low |
| frontend/src/explorer/ExplorerScene.ts | Per-frame loop over 28k points | Medium |

## Verdict: APPROVE WITH CHANGES

Recommendations 1 and 2 are medium and **not fixed** in this pass: both are architectural changes beyond a home-page redesign, and neither shows up in the demo (no frame drops observed; the screening runs once per 30 minutes). Flagged for a decision.

## Critical Issues (Must Fix)
None open.

## Recommendations
| # | Issue | File(s) | Why | Fix |
|---|-------|---------|-----|-----|
| 1 (medium) | Screening holds the GIL for ~15 s every 30 min | explorer_screening.py | Other API calls slow during the run | Run it in a process pool, or precompute on a schedule |
| 2 (medium) | Per-frame JS loop sets 28k point positions | ExplorerScene.ts | Main-thread cost grows with the catalog | Move to a custom primitive with a vertex buffer updated once per worker tick |
| 3 (low) | Catalog is 1.7 MB gzipped on a cold visit | explorer_catalog.py | Mobile first load | Send TLE lines in a compact binary or drop unused fields |

## Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | Preload the fonts used above the fold | Saves a swap on slow networks; CLS already < 0.01 |

## Resource Budget
| Resource | Current | After Plan | Concern? |
|----------|---------|-----------|----------|
| Requests per page load | catalog | catalog + approaches (202 polls every 3 s until ready) | No |
| Event listeners added | — | 3 keydown (Escape layers, "/"), cleaned up | No |
| Memory growth per hour | — | Approaches result replaced every 30 min; no accumulation | No |
| Startup time impact | Cesium + Recharts preloaded | Neither on the critical path | Improved |
| Bundle size impact | — | +2 fonts (~37 kB woff2), +1 worker (24 kB) | No |

## Hot Path Analysis
Per frame: GMST rotation, 28k position writes, label/marker updates, a reveal step for ≤ 2 polylines during 0.6–1.2 s. Per second: SGP4 for 28k objects in the worker, one transferable buffer, store updates. Measured CLS: 0.0000–0.0052 at 375/768/1280/1920.

## Verdict Details
- Memory Management: PASS
- IPC Efficiency: PASS (worker messages transfer buffers)
- I/O Patterns: PASS (catalog cacheable: ETag + max-age=300, 304 verified)
- Startup Impact: PASS
- Long-Session Stability: PASS
