"""REST routes. Thin wrappers around the service layer."""
from __future__ import annotations

import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse

from .. import __version__
from ..agent.orchestrator import run_analysis
from ..config import get_settings
from ..data import celestrak, explorer_catalog
from ..scenarios.registry import list_scenarios
from ..schemas.models import (AgentAnalyzeRequest, AgentRunResponse, ApproachesResponse, ApproveRequest,
                              AutopilotRequest, CatalogRefreshResponse, EvaluateRequest, EvaluateResponse,
                              JunkTypesResponse, RemoveRequest, RemoveResponse, SpawnBatchResponse, SpawnRandomRequest,
                              SpawnRequest, SpawnResponse,
                              CatalogResponse, DataRefreshResponse,
                              DecisionResponse, HealthResponse, ObjectDetail, ObjectListResponse, PerceptionModelInfo,
                              PerceptionResponse, PlanRequest, PlanResponse, RejectRequest, ScenarioDetail, ScenarioSummary, ScreenRequest,
                              ScreenResponse, SecondaryCheckRequest, SecondaryCheckResponse, SimulationState,
                              TrajectoryBatchRequest, TrajectoryBatchResponse, TrajectoryResponse)
from ..simulation import explorer_screening, sandbox, service
from ..simulation.session import get_store

router = APIRouter(prefix="/api")

DISCLAIMER = ("Research and simulation prototype. Positions are propagated estimates from public orbital elements "
              "or synthetic states; nothing here is flight software and no spacecraft is commanded.")


def _session(scenario_id: str):
    try:
        return get_store().get(scenario_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except service.NotFound as exc:
        raise HTTPException(status_code=404, detail=exc.args[0] if exc.args else str(exc)) from exc
    except service.BadRequest as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except service.Conflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except celestrak.DataUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/health", response_model=HealthResponse)
def health():
    s = get_settings()
    return HealthResponse(status="ok", version=__version__, agent_mode=s.agent_mode,
                          gemini_configured=bool(s.gemini_api_key), network_allowed=s.allow_network,
                          scenarios=[x["scenario_id"] for x in list_scenarios()], disclaimer=DISCLAIMER)


@router.get("/scenarios", response_model=list[ScenarioSummary])
def scenarios():
    return list_scenarios()


@router.get("/scenarios/{scenario_id}", response_model=ScenarioDetail)
def scenario(scenario_id: str):
    return service.scenario_detail(_session(scenario_id))


@router.post("/scenarios/{scenario_id}/reset", response_model=ScenarioDetail)
def reset_scenario(scenario_id: str, live: bool = Query(default=False, description="rebuild from a fresh CelesTrak download (real scenario only)")):
    try:
        sess = get_store().reset(scenario_id, live=live)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except celestrak.DataUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return service.scenario_detail(sess)


@router.get("/objects", response_model=ObjectListResponse)
def objects(scenario_id: str = Query(...)):
    return service.list_objects(_session(scenario_id))


@router.get("/objects/{object_id}", response_model=ObjectDetail)
def object_detail(object_id: str, scenario_id: str = Query(...), at: Optional[str] = Query(default=None)):
    return _call(service.object_detail, _session(scenario_id), object_id, at)


@router.get("/objects/{object_id}/trajectory", response_model=TrajectoryResponse)
def object_trajectory(object_id: str, scenario_id: str = Query(...), start: Optional[str] = None,
                      end: Optional[str] = None, step_s: float = Query(default=60.0, ge=1.0, le=3600.0),
                      maneuver_id: Optional[str] = None,
                      variant: Optional[str] = Query(default=None, description="committed (default) | original")):
    """The primary's default trajectory includes its committed burns; `variant=original` leaves them out."""
    return _call(service.trajectory, _session(scenario_id), object_id, start, end, step_s, maneuver_id, variant)


@router.post("/objects/trajectories", response_model=TrajectoryBatchResponse)
def object_trajectories(req: TrajectoryBatchRequest):
    if len(req.object_ids) > 200:
        raise HTTPException(status_code=400, detail="at most 200 objects per batch request")
    return _call(service.trajectories, _session(req.scenario_id), req.object_ids, req.start, req.end, req.step_s,
                 req.variant)


@router.post("/conjunctions/screen", response_model=ScreenResponse)
def screen(req: ScreenRequest):
    return _call(service.run_screening, _session(req.scenario_id), req.primary_id, req.start, req.end, req.pc_policy,
                 req.screening_radius_km)


@router.get("/conjunctions", response_model=ScreenResponse)
def conjunctions(scenario_id: str = Query(...)):
    """The session's current screening results (without recomputing)."""
    return _call(service.current_screening, _session(scenario_id))


@router.get("/conjunctions/{conjunction_id}")
def conjunction(conjunction_id: str, scenario_id: str = Query(...)):
    return _call(service.get_conjunction, _session(scenario_id), conjunction_id)


@router.post("/conjunctions/{conjunction_id}/maneuvers", response_model=PlanResponse)
def plan(conjunction_id: str, req: PlanRequest):
    return _call(service.plan_for_conjunction, _session(req.scenario_id), conjunction_id, req.max_candidates,
                 req.earliest_burn, req.pc_policy, req.lead_orbits, req.dv_magnitudes_mps, req.directions)


@router.get("/conjunctions/{conjunction_id}/maneuvers", response_model=PlanResponse)
def existing_plan(conjunction_id: str, scenario_id: str = Query(...)):
    """The plan already computed for this conjunction in the session."""
    return _call(service.get_plan, _session(scenario_id), conjunction_id)


@router.post("/maneuvers/{maneuver_id}/secondary-check", response_model=SecondaryCheckResponse)
def secondary_check(maneuver_id: str, req: SecondaryCheckRequest):
    return _call(service.run_secondary_check, _session(req.scenario_id), maneuver_id)


@router.post("/agent/analyze", response_model=AgentRunResponse)
def agent_analyze(req: AgentAnalyzeRequest):
    sess = _session(req.scenario_id)
    try:
        return run_analysis(sess, conjunction_id=req.conjunction_id, mode=req.mode, max_candidates=req.max_candidates)
    except service.NotFound as exc:
        raise HTTPException(status_code=404, detail=exc.args[0] if exc.args else str(exc)) from exc
    except service.BadRequest as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/perception", response_model=PerceptionResponse)
def perception(scenario_id: str = Query(...),
               horizon_s: Optional[float] = Query(default=None, gt=0, le=7 * 86400),
               critical_radius_km: Optional[float] = Query(default=None, gt=0, le=100),
               tracked_radius_km: Optional[float] = Query(default=None, gt=0, le=200),
               maneuver_id: Optional[str] = None, include_hidden: bool = False, trails: bool = True,
               baseline: bool = Query(default=False, description="perceive along the original trajectory even after an approval"),
               start: Optional[str] = Query(default=None, description="measure the horizon from this time (ISO 8601) instead of the window start")):
    """ML-ranked, physics-verified objects around the primary (the Waymo-style perception layer)."""
    return _call(service.perception, _session(scenario_id), horizon_s, critical_radius_km, tracked_radius_km,
                 maneuver_id, include_hidden, trails, baseline, start)


@router.get("/perception/model", response_model=PerceptionModelInfo)
def perception_model():
    return service.perception_model_info()


@router.get("/simulation/state", response_model=SimulationState)
def simulation_state(scenario_id: str = Query(...)):
    return _session(scenario_id).state_summary()


@router.post("/simulation/approve", response_model=DecisionResponse)
def approve(req: ApproveRequest):
    return _call(service.approve, _session(req.scenario_id), req.maneuver_id)


@router.post("/simulation/reject", response_model=DecisionResponse)
def reject(req: RejectRequest):
    return _call(service.reject, _session(req.scenario_id), req.maneuver_id, req.reason)


@router.post("/simulation/autopilot", response_model=SimulationState)
def autopilot(req: AutopilotRequest):
    """Sandbox only: let the simulation commit avoidance burns itself (off: burns wait for approval)."""
    return _call(service.set_autopilot, _session(req.scenario_id), req.enabled)


@router.get("/sandbox/junk-types", response_model=JunkTypesResponse)
def sandbox_junk_types():
    """The junk kinds the sandbox can spawn, with their miss-distance bands and designs."""
    return sandbox.junk_types()


def _now(sess, value: str) -> float:
    return _call(service._parse_time, value, sess.scenario.start_unix)


@router.post("/sandbox/spawn", response_model=SpawnResponse)
def sandbox_spawn(req: SpawnRequest):
    """Sandbox only: spawn one junk object whose closest approach to the primary follows the request or its kind's band."""
    sess = _session(req.scenario_id)
    drop = None
    if req.drop_point is not None:
        if "lat_deg" not in req.drop_point or "lon_deg" not in req.drop_point:
            raise HTTPException(status_code=400, detail="drop_point needs lat_deg and lon_deg")
        drop = (float(req.drop_point["lat_deg"]), float(req.drop_point["lon_deg"]))
    spec = sandbox.SpawnSpec(kind=req.kind, time_to_tca_s=req.time_to_tca_s, drop_point=drop, offset_km=req.offset_km,
                             axis=req.axis, crossing_angle_deg=req.crossing_angle_deg, seed=req.seed, name=req.name)
    return _call(sandbox.spawn, sess, _now(sess, req.now), spec)


@router.post("/sandbox/spawn_random", response_model=SpawnBatchResponse)
def sandbox_spawn_random(req: SpawnRandomRequest):
    """Sandbox only: spawn several junk objects of mixed kinds spread over the next two orbits."""
    sess = _session(req.scenario_id)
    return _call(sandbox.spawn_random, sess, _now(sess, req.now), req.count, req.seed)


@router.post("/sandbox/remove", response_model=RemoveResponse)
def sandbox_remove(req: RemoveRequest):
    """Sandbox only: take spawned junk away (specific ids, or the most recently spawned `count`)."""
    sess = _session(req.scenario_id)
    return _call(sandbox.remove, sess, _now(sess, req.now), req.object_ids, req.count)


@router.post("/sandbox/evaluate", response_model=EvaluateResponse)
def sandbox_evaluate(req: EvaluateRequest):
    """Sandbox only: screen from `now` and let the autopilot plan, check and commit burns for passes that need mitigation."""
    sess = _session(req.scenario_id)
    return _call(sandbox.evaluate, sess, _now(sess, req.now), req.earliest_burn_after_s)


@router.post("/data/refresh", response_model=DataRefreshResponse)
def refresh_data():
    """Download fresh CelesTrak groups into the cache and rebuild the real scenario."""
    from ..scenarios import real
    try:
        metas = celestrak.refresh_groups(real.REFRESH_GROUPS)
        get_store().reset(real.SCENARIO_ID, live=True)
    except celestrak.DataUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return DataRefreshResponse(status="ok", detail=f"refreshed {len(metas)} CelesTrak groups and rebuilt '{real.SCENARIO_ID}'",
                               groups=metas)


@router.get("/catalog", response_model=CatalogResponse)
def catalog(request: Request):
    """Every tracked object on orbit with its TLE and SATCAT metadata, for the explorer page.

    Cacheable for five minutes and revalidated with an ETag, so a return visit costs a 304, not the
    whole catalog again.
    """
    try:
        body = explorer_catalog.get_catalog_json()
        etag = explorer_catalog.get_catalog_etag()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    headers = {"ETag": etag, "Cache-Control": "public, max-age=300"}
    if etag in [t.strip() for t in request.headers.get("if-none-match", "").split(",")]:
        return Response(status_code=304, headers=headers)
    # Serialised once per process; 25k+ rows are too many to re-validate on every request.
    return Response(content=body, media_type="application/json", headers=headers)


@router.get("/catalog/approaches", response_model=ApproachesResponse,
            responses={202: {"description": "Screening is running; retry after the Retry-After header"}})
def catalog_approaches(response: Response):
    """GPM's close approaches over the next 24 hours, screened against the explorer catalog.

    Computed on a background thread and cached for half an hour, so the first request after startup may
    get 202 while the screening runs.
    """
    try:
        state = explorer_screening.get_approaches()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if state["status"] == "error":
        raise HTTPException(status_code=503, detail=f"screening failed: {state['error']}")
    if state["status"] == "computing":
        return JSONResponse(status_code=202, content={"status": "computing", "retry_after_s": 3}, headers={"Retry-After": "3"})
    result = state["result"]
    now = time.time()
    response.headers["Cache-Control"] = "public, max-age=60"
    return {**result, "approaches": [a for a in result["approaches"] if a["tca_unix"] > now]}


@router.post("/catalog/refresh", response_model=CatalogRefreshResponse)
def refresh_catalog():
    """Rebuild the explorer catalog from CelesTrak (at most once every two hours)."""
    try:
        return explorer_catalog.refresh_catalog()
    except celestrak.DataUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
