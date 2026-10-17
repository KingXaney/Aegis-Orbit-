---
title: Reference frames and time
type: concept
tags: [frames, time, physics]
sources: [codebase-a34844b]
updated: 2026-10-17
---

# Reference frames and time

All backend states use TEME in km and km/s, and time is unix seconds in UTC. RTN describes burns and
covariances, the encounter plane is used for Pc, and the Earth-fixed frame exists only for display and
geodetic read-outs.

## TEME (canonical)

**True Equator, Mean Equinox** of date is SGP4's native output frame. Aegis Orbit keeps *every* state
in TEME, including the two-body + J2 integration, which treats TEME as inertial. J2 is symmetric about
the TEME z-axis, the spin axis, which makes TEME a natural frame for that model
([frames.py:1-9](../../../backend/app/physics/frames.py#L1-L9)).

## RTN (local orbital frame)

R = r̂ is radial. N = (r × v)/|r × v| is the orbit normal, or cross-track. T = N × R is along-track
([frames.py:20-29](../../../backend/app/physics/frames.py#L20-L29)). The planner's six burn directions
are ±R, ±T and ±N ([maneuver_planner.py:55-61](../../../backend/app/physics/maneuver_planner.py#L55-L61)).
Object covariances are stored as RTN diagonals and rotated to TEME with M C Mᵀ
([frames.py:40-42](../../../backend/app/physics/frames.py#L40-L42)). T matches the velocity direction
only on a circular orbit *(background)*.

## Earth-fixed (pseudo-fixed)

TEME is rotated about z by GMST (IAU 1982 polynomial), with UT1 ≈ UTC assumed and polar motion
neglected ([frames.py:45-66](../../../backend/app/physics/frames.py#L45-L66)). The backend uses this
frame only for geodetic latitude, longitude and altitude, iterated on WGS-84
([frames.py:69-86](../../../backend/app/physics/frames.py#L69-L86)). The frontend does the same rotation
on every frame with Cesium's `computeTemeToPseudoFixedMatrix`. Velocities also need the −ω × r
transport term ([frames.ts:30-51](../../../frontend/src/globe/frames.ts#L30-L51)). Without it, a LEO
velocity is off by ω·|r| ≈ 7.29e-5 rad/s × 6 800 km ≈ 0.5 km/s.

## Encounter plane

The encounter plane is perpendicular to the relative velocity at TCA, with e₁ along the in-plane miss.
It is used only for [collision probability](collision-probability.md).

## Time

- **Internally,** time is float unix seconds, with leap seconds ignored
  ([time_utils.py:1-6](../../../backend/app/physics/time_utils.py#L1-L6)).
- **At the API,** it is ISO 8601 UTC with a trailing `Z`, rounded to the millisecond
  ([time_utils.py:27-34](../../../backend/app/physics/time_utils.py#L27-L34)).
- **For SGP4,** it is a Julian date split into `(jd, fr)`
  ([time_utils.py:47-54](../../../backend/app/physics/time_utils.py#L47-L54)).
- **In the frontend,** a `TimeBridge` anchors `JulianDate` to a reference unix time so that
  conversions stay exact ([frames.ts:8-25](../../../frontend/src/globe/frames.ts#L8-L25)).

## Constants

The numerical model uses WGS-84 (μ = 398 600.4418 km³/s², R_E = 6 378.137 km, J2 = 1.08262668e-3),
whereas SGP4 uses WGS-72 internally (R_E = 6 378.135 km). The code judges the difference to be far
below either model's accuracy here ([constants.py:1-12](../../../backend/app/physics/constants.py#L1-L12)).

## See also

[Propagation models](propagation-models.md) · [Avoidance maneuvers](avoidance-maneuvers.md) ·
[Frontend globe](../components/frontend-globe.md)
