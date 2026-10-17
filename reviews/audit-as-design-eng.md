# Design Engineering Audit: Home page redesign (catalog explorer)

**Perspective**: Design Engineer
**Date**: 2026-10-17
**Plan**: ~/.claude/plans/pasted-content-id-60c7-goal-hidden-lovelace.md (implemented on `feature/homepage-redesign`)

## Plan Summary
Replaces the centred title, glass panels and big-number row with a flight-deck rail beside the live globe: graphite neutrals, cockpit inks for object types, one magenta accent for GPM, Barlow Condensed / B612 / IBM Plex Mono.

## Files Reviewed
| File | Visual Role | Risk |
|------|-------------|------|
| frontend/src/index.css | Tokens, type scale, component layer | Low |
| frontend/src/explorer/ExplorerPage.tsx | Layout grid, rail, globe overlays | Low |
| frontend/src/explorer/Approaches.tsx | Signature module | Low |
| frontend/src/explorer/ExplorerScene.ts | Globe inks, magenta line, TCA marker | Low |
| frontend/src/explorer/{FilterPanel,FindBox,DetailsCard}.tsx | Controls and sheets | Low |

## Verdict: APPROVE

## Critical Issues (Must Fix)
None open. Found and fixed during the pass:
| # | Issue | File(s) | Impact | Fix |
|---|-------|---------|--------|-----|
| 1 | Unlayered `.x-*` classes beat Tailwind utilities (`pl-10` lost, search icon over placeholder) | index.css | Broken field, unpredictable overrides | Component classes moved into `@layer components` |
| 2 | Shared 13 px root made every rem step 3.25 px (rows 33 px) | index.css, main.tsx | Spacing off the 4 px grid, small targets | `html.x-root` sets 16 px on the home page only |
| 3 | B612 Mono sets punctuation flush left ("1. 85 km", "15, 939") | index.css | Numbers misread | Data face is IBM Plex Mono; counts use B612 tabular figures |

## Recommendations
| # | Issue | File(s) | Why | Fix |
|---|-------|---------|-----|-----|
| 1 | Find sits below the fold at 1280 × 800 | ExplorerPage.tsx | Second way into the globe is less visible | Consider a compact find at the top of the globe on desktop |
| 2 | Globe key wraps to two lines at 375 px | ExplorerPage.tsx | Minor crowding over the globe | Shorten labels on phones ("Satellites") |

## Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | Light "printed chart" theme | Tokens already isolate every colour; deferred by request |
| 2 | Align /mission to the same tokens | One identity across both pages; deferred by request |

## Design System Compliance
Every explorer colour is a CSS variable in `:root` (exposed via `@theme inline`); the globe reads them through `palette.ts`, so no hex lives in TypeScript. Type sizes come from a 12/14/16/21/28/36/48 scale; radii are 4/8/12 and concentric where nested. The simulator's tokens are untouched.

## Visual State Coverage
| Component/Element | Hover | Focus | Active | Disabled | Loading | Empty | Error | Dark Mode |
|-------------------|-------|-------|--------|----------|---------|-------|-------|-----------|
| Primary action | ✓ | ✓ | ✓ scale | n/a | n/a | n/a | n/a | ✓ (only mode) |
| Closest pass / pass rows | ✓ | ✓ previews | pressed state | n/a | skeleton | "no passes" | retry | ✓ |
| Find combobox | ✓ | ✓ | n/a | n/a | n/a | "no match" | n/a | ✓ |
| Filters sheet controls | ✓ | ✓ | ✓ | ✓ Filters before ready | n/a | n/a | n/a | ✓ |
| Globe | n/a | n/a | n/a | n/a | staged messages | reset prompt | WebGL message | ✓ |

## Verdict Details
- Design Token Fidelity: PASS
- Visual State Coverage: PASS
- Dark Mode Parity: PASS (dark only, by request; light set can be added by redefining the variables)
- Animation Quality: PASS (transform/opacity, 150–250 ms, reduced-motion fallbacks)
- Visual Consistency: PASS
