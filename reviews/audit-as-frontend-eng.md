# Frontend Engineering Audit: Home page redesign (catalog explorer)

**Perspective**: Frontend Engineer
**Date**: 2026-10-17
**Plan**: ~/.claude/plans/pasted-content-id-60c7-goal-hidden-lovelace.md (implemented)

## Plan Summary
New Zustand state for approaches (polled 202 → 200), preview/pin keys, URL selection; worker gains a 'route' request; scene gains the magenta line and approach geometry; pages and Cesium are code-split.

## Files Reviewed
| File | Frontend Role | Risk |
|------|--------------|------|
| explorer/store.ts | State, polling, URL | Medium |
| explorer/GlobeCanvas.tsx | Store → scene/worker bridge | Medium |
| explorer/Approaches.tsx | 1 Hz countdown list | Low |
| main.tsx, vite.config.ts | Code splitting | Medium |

## Verdict: APPROVE

## Critical Issues (Must Fix)
None open. Fixed in this pass:
| # | Issue | File(s) | Why It Breaks | Code Fix |
|---|-------|---------|---------------|----------|
| 1 | Route effect re-flew on data refresh | GlobeCanvas.tsx | `active` gets a new identity every refresh, `fly` recomputed true | `flownTo` ref: fly once per pinned key |
| 2 | Static import of the simulator + name-list manualChunks | main.tsx, vite.config.ts | Home page preloaded Cesium (4.2 MB) and Recharts | Lazy pages; function manualChunks; preload helper out of the Cesium chunk |
| 3 | Early `focus()` from a shared link was dropped | ExplorerScene.ts | No state yet → returned silently | `pendingFocus` applied on first state |

## Recommendations
| # | Issue | File(s) | Why | Fix |
|---|-------|---------|-----|-----|
| 1 | `approachesTimer` is module-level | store.ts | Fine for a page that never unmounts; leaks in tests or a future router | Expose a `stopApproaches()` and call it on unmount if the page ever becomes routable |
| 2 | Escape handlers coordinate through `defaultPrevented` | Approaches, DetailsCard, FilterPanel | Works, but implicit | A tiny layer stack in the store if more overlays arrive |

## Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | Unit test for the route effect's fly-once rule | Regression guard for the camera bug |

## Render Path Analysis
The worker posts at 1 Hz; the store updates `modelLive`, `live` and (once) `propagated`. Approaches re-renders once a second for the countdowns (≤ 6 rows by default). Rows subscribe to their own pinned flag, so pinning re-renders one row, not the list. The scene runs outside React; GlobeCanvas effects only post messages.

## Type Safety Assessment
`ApproachRecord`/`ApproachesResponse`/`ApproachesPending` mirror the Pydantic models; the 202 body is discriminated by `'status' in body`. `tsc --noEmit` is clean; 35 Vitest tests pass (4 new).

## Verdict Details
- Component Architecture: PASS
- State Management: PASS
- Type Safety: PASS
- Rendering Performance: PASS
- Bundle Impact: PASS (home critical path: entry 1.5 kB + React 224 kB + page 37 kB + vendor 32 kB; Cesium lazy; Recharts only on /mission)
