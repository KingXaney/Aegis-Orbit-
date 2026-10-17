# Accessibility Audit: Home page redesign (catalog explorer)

**Perspective**: Accessibility Engineer
**Date**: 2026-10-17
**Plan**: ~/.claude/plans/pasted-content-id-60c7-goal-hidden-lovelace.md (implemented)

## Plan Summary
New interactive rail (passes, find combobox), a modal filters sheet, live regions for screening and catalog status. Verified with axe-core 4.10.3 on the production build: **0 violations** idle and with a pass pinned.

## Files Reviewed
| File | A11y Role | Risk |
|------|----------|------|
| ExplorerPage.tsx | Landmarks, headings, status overlays | Low |
| Approaches.tsx | Toggle buttons with previews | Low |
| FindBox.tsx | ARIA 1.2 combobox | Low |
| FilterPanel.tsx | Modal dialog | Low |
| DetailsCard.tsx | Region with live values | Low |

## Verdict: APPROVE

## Critical Issues (Must Fix)
None open. Fixed in this pass:
| # | Issue | WCAG Criterion | File(s) | Impact | Fix |
|---|-------|---------------|---------|--------|-----|
| 1 | Search results used role=listbox around buttons | 4.1.2 | FilterPanel.tsx (old) | Wrong semantics | Rebuilt as combobox + listbox/options with aria-activedescendant |
| 2 | Filters dialog had no aria-modal or focus trap | 2.4.3 | FilterPanel.tsx | Tab escaped behind it | aria-modal, Tab trap, `inert` page, focus returns to Filters |
| 3 | aria-label on role-less elements (globe div, pending values) | 4.1.2 | GlobeCanvas.tsx, DetailsCard.tsx | axe serious | Removed / replaced with sr-only text |
| 4 | Control outlines at 1.35:1 | 1.4.11 | index.css | Inputs hard to see | Control outline #646d7b, ≥3:1 on every surface |
| 5 | Targets 26–33 px | 2.5.8 | many | Hard to hit | All ≥40 px (links extend with ::after) |

## Recommendations
| # | Issue | WCAG Criterion | Fix |
|---|-------|---------------|-----|
| 1 | The globe itself is mouse-only | 2.1.1 | Every globe action has a rail equivalent (find, passes, Show GPM); keep it that way |

## Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | `translate="no"` on object names and NORAD IDs | Machine translation mangles designators |

## Keyboard Navigation Walkthrough
| Step | Action | Expected Focus | Expected Announcement | Plan Handles? |
|------|--------|---------------|----------------------|---------------|
| 1 | Tab | Aegis Orbit (home) | link, current page | Yes |
| 2 | Tab | Simulator | link | Yes |
| 3 | Tab | Plan an avoidance burn | link | Yes |
| 4 | Tab | Show GPM | button | Yes |
| 5 | Tab | Closest pass | "Closest pass: SCS-01 H, 1.85 km, in 3 hours …", toggle | Yes, previews on globe |
| 6 | Tab ×5 | Pass rows | name, distance, countdown, UTC time | Yes |
| 7 | Tab | Show all 70 passes | button | Yes |
| 8 | Tab | Filters | button, expanded state | Yes |
| 9 | Tab or "/" | Find combobox | combobox, collapsed | Yes |
| 10 | Enter on Filters | Close filters | dialog "Filters" | Yes, trapped, Escape returns |

## ARIA Checklist
| Element | Role | Label | States | Keyboard | Notes |
|---------|------|-------|--------|----------|-------|
| Pass rows | button | composite label | aria-pressed | Enter/Space, focus previews | |
| Find | combobox + listbox/option | label (sr-only) | aria-expanded, aria-activedescendant | ↑ ↓ Enter Escape, "/" | |
| Filters sheet | dialog | "Filters" heading | aria-modal | Tab trap, Escape | |
| Screening status | status | text | aria-busy on section | n/a | |

## Verdict Details
- Screen Reader Compatibility: PASS
- Keyboard Navigation: PASS
- Focus Management: PASS
- Color Contrast: PASS (text ≥ 6.4:1; magenta on bg 7.25:1; controls ≥ 3:1)
- Motion Sensitivity: PASS (camera fly, line reveal, idle rotation, pulse, press scale all off under reduced motion)
