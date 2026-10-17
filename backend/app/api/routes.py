"""REST routes. Thin wrappers around the service layer."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Response

from .. import __version__
from ..agent.orchestrator import run_analysis
from ..config import get_settings
from ..data import celestrak, explorer_catalog
from ..scenarios.registry import list_scenarios
from ..schemas.models import (AgentAnalyzeRequest, AgentRunResponse, ApproveRequest, CatalogRefreshResponse,
                              CatalogResponse, DataRefreshResponse,
                              DecisionResponse, HealthResponse, ObjectDetail, ObjectListResponse, PerceptionModelInfo,
                              PerceptionResponse, PlanRequest, PlanResponse, RejectRequest, ScenarioDetail, ScenarioSummary, ScreenRequest,
                              ScreenResponse, SecondaryCheckRequest, SecondaryCheckResponse, SimulationState,
                              TrajectoryBatchRequest, TrajectoryBatchResponse, TrajectoryResponse)
from ..simulation import service
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
                      maneuver_id: Optional[str] = None):
    return _call(service.trajectory, _session(scenario_id), object_id, start, end, step_s, maneuver_id)


@router.post("/objects/trajectories", response_model=TrajectoryBatchResponse)
def object_trajectories(req: TrajectoryBatchRequest):
    if len(req.object_ids) > 200:
        raise HTTPException(status_code=400, detail="at most 200 objects per batch request")
    return _call(service.trajectories, _session(req.scenario_id), req.object_ids, req.start, req.end, req.step_s)


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
               baseline: bool = Query(default=False, description="perceive along the original trajectory even after an approval")):
    """ML-ranked, physics-verified objects around the primary (the Waymo-style perception layer)."""
    return _call(service.perception, _session(scenario_id), horizon_s, critical_radius_km, tracked_radius_km,
                 maneuver_id, include_hidden, trails, baseline)


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
def catalog():
    """Every tracked object on orbit with its TLE and SATCAT metadata, for the explorer page."""
    try:
        body = explorer_catalog.get_catalog_json()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    # Serialised once per process; 25k+ rows are too many to re-validate on every request.
    return Response(content=body, media_type="application/json")


@router.post("/catalog/refresh", response_model=CatalogRefreshResponse)
def refresh_catalog():
    """Rebuild the explorer catalog from CelesTrak (at most once every two hours)."""
    try:
        return explorer_catalog.refresh_catalog()
    except celestrak.DataUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
