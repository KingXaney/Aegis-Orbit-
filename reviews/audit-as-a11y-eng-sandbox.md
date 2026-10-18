# Accessibility Audit: Sandbox HUD redesign (scenario C)

**Perspective**: Accessibility Engineer
**Date**: 2026-10-18
**Plan**: Sandbox UI/UX pass (uncommitted working tree): flight-deck tokens on /mission, junk tray, clock bar with look-ahead rail, autopilot section

## Plan Summary
Brings the mission page onto the home page's flight-deck tokens and rebuilds the sandbox HUD: a junk tray with a stepper and one primary action, a one-row clock bar, and a look-ahead rail of clickable passes. The accessibility risks: the live regions around a clock that ticks every frame, a rail with many small targets, and custom switches.

## Files Reviewed
| File | A11y Role | Risk |
|------|----------|------|
| frontend/src/sandbox/LookAheadRail.tsx | Composite widget (group of toggle buttons), tooltip | High |
| frontend/src/panels/ClockControls.tsx | Transport controls, live status | High |
| frontend/src/sandbox/JunkTray.tsx | Disclosure, stepper, switch, primary action | Medium |
| frontend/src/components/ui.tsx | Button, Badge, Toggle (switch), Section | Medium |
| frontend/src/index.css | Tokens, `.switch`, focus styles, reduced motion | Medium |
| frontend/src/App.tsx | Notice live region, overlay stacking | Low |
| frontend/src/panels/{TopBar,MissionPanel,LayerControls,DodgeCard,GhostWarning,ObjectInspector}.tsx | Restyled | Low |

## Verdict: APPROVE

## Critical Issues (Must Fix)
None open. Found and fixed during the pass:
| # | Issue | WCAG Criterion | File(s) | Impact | Fix |
|---|-------|---------------|---------|--------|-----|
| 1 | `role="status"` wrapped the running UTC clock | 4.1.3 Status Messages | ClockControls.tsx | Screen reader announces the time every frame | Live region holds only the state ("Live", "Slow motion: dodge burn") |
| 2 | Next-event live region included the countdown | 4.1.3 | ClockControls.tsx | Announced every second | `aria-live` on the event label only; the countdown sits outside it |
| 3 | Each rail pass was its own tab stop (15+ stops) | 2.4.3 Focus Order, 2.1.1 Keyboard | LookAheadRail.tsx | Tab fatigue between the clock and the panel | Roving tabindex: one stop (selected pass, else first), Arrow/Home/End move |
| 4 | Burn and ghost markers had `tabIndex=0` on non-interactive elements | 4.1.2 Name, Role, Value | LookAheadRail.tsx | Focus stops that do nothing | `role="img"` + `aria-label`, not focusable |
| 5 | Tertiary text `#56657f` at 3.05:1 on panels | 1.4.3 Contrast | index.css | Unreadable labels | `--color-dim: #838c99` (5.28:1 panel, 4.81:1 raised) |
| 6 | rem heights on a 13 px root shrank controls (`h-9` = 29 px) | 2.5.8 Target Size | ui.tsx, JunkTray, ClockControls, TopBar | Small targets | px heights: play 36, spawn and stepper 40, buttons 28/32 |
| 7 | Tray heading sat inside its disclosure button | 1.3.1 Info and Relationships | JunkTray.tsx | Heading lost from the headings list | `<h2><button aria-expanded aria-controls>` |
| 8 | Autopilot switch only moved after the backend answered | 3.2.2 / 4.1.2 (state) | JunkTray.tsx | Looks dead; a second click sent the stale value | Optimistic state with `aria-busy`, reverts if the request fails |

## Recommendations
| # | Issue | WCAG Criterion | Fix |
|---|-------|---------------|-----|
| 1 | The mission panel's "Engaged" toggle has the same stale-state double-click issue | 4.1.2 | Share the optimistic toggle with the tray (lift into the store) |
| 2 | Rail pass bars are 18 px wide; adjacent passes can overlap hit areas | 2.5.8 (spacing exception) | Merge passes closer than ~1 % of the rail into one cluster marker |
| 3 | Pass tone is colour (red/blue/grey); also stated in each label | 1.4.1 Use of Color | Add a shape cue (e.g., notch on threat bars) |
| 4 | The dodge card and ghost warning still cover the globe on phones while a burn is near | 1.4.10 Reflow | Collapse to a one-line banner below 640 px |

## Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 1 | A keyboard shortcut (e.g. J) to spawn junk | The page already binds Space to pause |
| 2 | `aria-describedby` from each pass to the tooltip | The tooltip duplicates the label today, so this is optional |

## Keyboard Navigation Walkthrough
| Step | Action | Expected Focus | Expected Announcement | Plan Handles? |
|------|--------|---------------|----------------------|---------------|
| 1 | Tab | "Aegis Orbit" home link | "Aegis Orbit, home. Backend online, link" | Yes |
| 2 | Tab ×3 | Scenario select, Screen now, Reset | Labelled controls | Yes |
| 3 | Tab | Space junk disclosure | "Space junk, heading level 2, button, expanded" | Yes |
| 4 | Tab | Autopilot switch | "Autopilot, switch, on" | Yes |
| 5 | Tab ×3 | Stepper −, count input, + | "One fewer piece", "Pieces per spawn 5", "One more piece" | Yes |
| 6 | Tab, Enter | Spawn 5 pieces | Button; then the notice is announced from the mounted live region | Yes |
| 7 | Tab ×4 | Play/pause, speed, Path, Slow for passes | "Pause the simulation", "Simulation speed 60×", "Path, switch, on" | Yes |
| 8 | Tab | Rail (one stop) | Group: "Next three hours: 9 events, 1 still need a dodge. Arrow keys move between passes." then the pass label | Yes |
| 9 | → → Enter | Next passes; select | "Rocket body 1 passes at 10.80 km, T−01:46:52 (monitoring), toggle button, pressed" and the panel opens on it | Yes (verified in Chrome) |
| 10 | Space anywhere off a control | Global | Pauses or resumes; skipped while a button or input has focus | Yes (unchanged) |

## ARIA Checklist
| Element | Role | Label | States | Keyboard | Notes |
|---------|------|-------|--------|----------|-------|
| Rail | group | Event summary + usage hint | — | Roving tabindex, ←/→/Home/End | |
| Rail pass | button | Name, miss, countdown, state | aria-pressed | Enter/Space selects | Opens the mission panel if collapsed |
| Rail burn / ghost | img | Description + countdown | — | Not focusable | |
| Tray header | h2 > button | "Space junk" | aria-expanded, aria-controls | Enter/Space | |
| Switches | switch (native checkbox) | Visible label | checked, aria-busy (autopilot) | Space | Focus ring 2 px magenta, offset 2 |
| Play/pause | button | "Pause/Resume the simulation" | — | Enter/Space | Icon only, labelled |
| Clock state | status | "Live" / "Paused" / "Slow motion: …" | — | — | Clock time is not live |
| Notice toast | status (always mounted) | — | — | — | Announced on change |

## Verdict Details
- Screen Reader Compatibility: PASS
- Keyboard Navigation: PASS
- Focus Management: PASS (no modals added; the rail keeps focus on the selected pass)
- Color Contrast: PASS (text ≥ 4.5:1; control outlines `#646d7b` ≥ 3:1; primary button text 7.25:1)
- Motion Sensitivity: PASS (pulse, toast entrance, chevron, switch and press scale all disabled under `prefers-reduced-motion`)
