# UX Audit: Home page redesign (catalog explorer)

**Perspective**: UX Engineer
**Date**: 2026-10-17
**Plan**: ~/.claude/plans/pasted-content-id-60c7-goal-hidden-lovelace.md (implemented)

## Plan Summary
A first-time visitor now reads what Aegis Orbit does in one sentence, sees the real GPM's next close approaches from the simulator's own screening, can preview and pin each on the globe, and has one action into the simulator.

## User Journey Map
1. Land → read the statement and the primary action — OK
2. See "GPM's close approaches in the next 24 hours", closest pass 1.85 km, countdown — OK (skeleton and "Screening GPM against N objects…" while it computes)
3. Hover or focus a pass → both orbits cross at a marker on the globe — OK
4. Select a pass → pinned, camera flies there (phones scroll the globe into view) — OK
5. Escape → closes the topmost layer only — OK (fixed in this pass)
6. Find an object by name or NORAD ID → selected, globe turns, URL updated — OK
7. Filter → live, with "No objects match" + Reset when empty — OK
8. Plan an avoidance burn → /mission — OK
9. Share a link to an object (?object=) → opens it — OK

## Verdict: APPROVE

## Critical Issues (Must Fix)
None open. Fixed in this pass:
| # | Issue | Step in Journey | Impact on User | Fix |
|---|-------|----------------|----------------|-----|
| 1 | One Escape closed the sheet, the details card and the pin together | 5 | Lost context | Each handler marks the event; one layer per press |
| 2 | A pinned pass re-flew the camera on every 10-minute refresh | 4 | Camera jumped unprompted | Fly once per pin |
| 3 | Headline claimed every tracked object while 408 active satellites were loaded | 1 | Credibility | Catalog rebuilt (15,939 active); copy no longer says "every" |
| 4 | A pinned pass could only be cleared with Escape or a second click | 4 | Discoverability | Status line "Showing <name> on the globe" with a Clear button |

## Recommendations
| # | Issue | Impact | Fix |
|---|-------|--------|-----|
| 1 | Pinned pass is not in the URL | Can't share an approach | Add `?pass=<norad>@<tca>` alongside `?object=` |

## Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | "Plan a burn for this pass" from a pinned pass | The simulator only runs its scripted scenario today |

## Interaction Consistency Check
Hover previews and click pins on both the closest-pass card and the rows; Escape and outside actions follow one rule; the filters sheet behaves like a modal everywhere.

## Verdict Details
- Discoverability: PASS
- Flow Completeness: PASS
- Error Recovery: PASS (catalog, screening and WebGL failures each explain themselves and offer retry where it helps)
- Feedback & Status: PASS
- Consistency: PASS
