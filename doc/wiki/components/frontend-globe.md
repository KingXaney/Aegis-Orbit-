---
title: Frontend globe, clock and interpolation
type: component
tags: [frontend, cesium, visualisation]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Frontend globe, clock and interpolation

The browser keeps a single simulation clock. It interpolates backend-precomputed TEME trajectories
with cubic Hermite splines and rotates them into Cesium's Earth-fixed frame every frame. It never
invents an orbital state or calls the backend per frame.

## Simulation clock

`SimulationController` in [controller.ts](../../../frontend/src/simulation/controller.ts) is the only
source of the displayed time:

- The clock state is the window, the current time, whether it is playing, and the speed, given as
  simulation seconds per real second. Available speeds are 1 to 1 800×
  ([controller.ts:17](../../../frontend/src/simulation/controller.ts#L17)).
- A `requestAnimationFrame` loop advances the clock. Each frame's real-time step is capped at 0.25 s,
  so a backgrounded tab doesn't jump ahead. The clock clamps and pauses at the window end
  ([controller.ts:68-89](../../../frontend/src/simulation/controller.ts#L68-L89)).
- The globe reads `currentUnix` every frame. React subscribers are notified at most every 100 ms
  ([controller.ts:29-58](../../../frontend/src/simulation/controller.ts#L29-L58)).

## Interpolation

`SampledTrajectory` in [trajectory.ts](../../../frontend/src/simulation/trajectory.ts) interpolates
between samples:

- It uses cubic Hermite interpolation with both position and velocity, so the curve and its derivative
  match at each sample ([trajectory.ts:5-24](../../../frontend/src/simulation/trajectory.ts#L5-L24)).
- It finds the bracketing samples by binary search, drops samples with `null` positions and returns
  `null` outside the sampled span
  ([trajectory.ts:40-103](../../../frontend/src/simulation/trajectory.ts#L40-L103)).
- The test asserts **under 1 m position error and under 0.1 m/s velocity error** on a circular LEO
  orbit sampled at 60 s ([trajectory.test.ts:40](../../../frontend/src/simulation/trajectory.test.ts#L40)).
- The store requests 60 s samples for the synthetic scenario, 120 s for the real one and 60 s for
  maneuvered trajectories
  ([useAppStore.ts:176](../../../frontend/src/store/useAppStore.ts#L176),
  [useAppStore.ts:353](../../../frontend/src/store/useAppStore.ts#L353)).

## Globe scene

`GlobeScene` in [scene.ts](../../../frontend/src/globe/scene.ts) owns the Cesium viewer:

- **Imagery.** Without `VITE_CESIUM_ION_TOKEN` it uses the bundled offline Natural Earth II tiles
  ([scene.ts:80-87](../../../frontend/src/globe/scene.ts#L80-L87)). `scripts/copy-cesium.mjs` copies
  Cesium's static assets to `public/cesium/` before dev and build.
- **Clock sync.** Cesium evaluates entity positions during `clock.tick()`, which runs before
  `preUpdate`. The scene therefore sets Cesium's clock for the *next* frame in `postRender`, so every
  element drawn in a frame shares one time: entities, polylines, the spacecraft model and the tracking
  camera ([scene.ts:119-137](../../../frontend/src/globe/scene.ts#L119-L137)).
- **Frames.** Every position goes through `temeToFixed` on each evaluation, and velocities through
  `temeVelocityToFixed`, which includes −ω × r
  ([frames.ts:30-51](../../../frontend/src/globe/frames.ts#L30-L51)). See
  [reference frames](../concepts/reference-frames.md).
- **The TCA visual.** The danger region is a sphere whose radius is clamp(3 × miss, 2.5 km, 25 km),
  so it is deliberately enlarged. It sits with ghost markers at each object's TCA position and a miss
  vector between them ([scene.ts:336-392](../../../frontend/src/globe/scene.ts#L336-L392)). The panels,
  not the globe, show the true distances.
- **Rendered objects.** The real scenario draws the ISS plus the 80 objects closest in altitude band,
  a bound chosen for browser performance
  ([registry.py:78-82](../../../backend/app/scenarios/registry.py#L78-L82)).

## State store

`useAppStore` in [useAppStore.ts](../../../frontend/src/store/useAppStore.ts) is a Zustand store
holding the backend status, the scenario, objects, trajectories, screening results, plans, agent runs
and the layer and camera options. `loadScenario` pauses the clock, then fetches the detail, the
objects and a batch of trajectories, and then sets the window. If the backend session already holds a
screening and a plan (after a page reload, say), it rehydrates them
([useAppStore.ts:170-205](../../../frontend/src/store/useAppStore.ts#L170-L205)).

## Not yet ingested

The panels (`MissionPanel`, `CandidateChart`, `TimelineBar`, `ObjectInspector`, `LayerControls` and
`TopBar`), `App.tsx`, `GlobeView.tsx` and `spacecraft.ts` haven't been read. This page says nothing
about UI interactions beyond what the README describes.

## See also

[Reference frames](../concepts/reference-frames.md) · [Architecture](architecture.md) ·
[Synthetic scenario](../scenarios/synthetic-conjunction.md)
