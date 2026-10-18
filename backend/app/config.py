"""Application configuration.

All thresholds below are *demonstration* settings for this simulator. They are
documented and configurable; none of them is a universal safety standard.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import List, Optional, Tuple

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class PlannerProfile:
    """Planner grid and acceptance rules for one kind of scenario (demonstration settings).

    ``default`` is the realistic flow (human approval, long leads, small burns); ``sandbox`` is the
    live synthetic scenario, where junk appears with little warning and the autopilot must find a
    burn that meets the probability target *and* the distance target."""
    name: str
    lead_orbits: Tuple[float, ...]
    dv_magnitudes_mps: Tuple[float, ...]
    directions: Tuple[str, ...]
    max_dv_mps: float
    min_lead_time_s: float
    require_distance_target: bool = False
    earliest_burn_margin_s: float = 0.0  # a burn is never planned closer than this to "now"
    burn_spacing_s: float = 60.0  # and never closer than this to the previous committed burn
    screening_horizon_orbits: Optional[float] = None  # None: the scenario window


def _floats(csv: str) -> Tuple[float, ...]:
    return tuple(float(x) for x in csv.split(",") if x.strip())


def _strs(csv: str) -> Tuple[str, ...]:
    return tuple(x.strip() for x in csv.split(",") if x.strip())


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", REPO_ROOT / "backend" / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Agent -------------------------------------------------------------
    gemini_api_key: Optional[str] = None
    gemini_model: str = "gemini-3.8-flash"
    agent_mode: str = "auto"  # auto | gemini | deterministic
    agent_max_tool_calls: int = 16

    # --- Data --------------------------------------------------------------
    allow_network: bool = True
    data_cache_dir: Path = Path("data/cache")
    stale_elements_days: float = 30.0  # records older than this (vs. window) are flagged stale
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # --- Screening (demo settings) -----------------------------------------
    screening_radius_km: float = 25.0  # conjunction is reported when miss distance < this
    screening_coarse_step_s: float = 30.0
    altitude_filter_margin_km: float = 50.0
    co_orbital_min_relative_speed_kms: float = 0.01  # below this the pair is treated as co-orbital, not a conjunction
    explorer_prewarm: bool = True  # screen GPM against the explorer catalog at startup, for the home page

    # --- Risk thresholds (demo settings, not operational standards) -------
    pc_elevated_threshold: float = 1e-5
    pc_critical_threshold: float = 1e-4
    pc_mitigation_target: float = 1e-6
    unverified_distance_km: float = 10.0  # no covariance and miss < this => UNVERIFIED
    miss_distance_target_km: float = 5.0  # distance-based mitigation target when Pc cannot be computed

    # --- Maneuver planner (demo settings) ---------------------------------
    planner_lead_orbits: str = "0.5,1.0,1.5,2.0"
    planner_dv_magnitudes_mps: str = "0.05,0.1,0.2,0.35,0.5"
    planner_directions: str = "+T,-T,+R,-R,+N,-N"
    planner_max_dv_mps: float = 1.0  # delta-v budget proxy
    planner_min_lead_time_s: float = 1800.0
    planner_numerical_step_s: float = 10.0

    # --- Sandbox: the live synthetic scenario (demo settings) --------------
    # Short leads and larger burns, because spawned junk can arrive with a fraction of an orbit of
    # warning; the autopilot only commits burns that meet both the Pc and the distance target.
    sandbox_lead_orbits: str = "0.1,0.25,0.5,1.0"
    sandbox_dv_magnitudes_mps: str = "0.1,0.25,0.5,1.0,2.0,3.0,5.0"
    sandbox_directions: str = "+T,-T,+R,-R"
    sandbox_max_dv_mps: float = 5.0
    sandbox_min_lead_time_s: float = 300.0
    sandbox_earliest_burn_margin_s: float = 30.0
    sandbox_burn_spacing_s: float = 60.0
    sandbox_require_distance_target: bool = True
    sandbox_screening_horizon_orbits: float = 2.0
    sandbox_anchor_every_s: float = 7200.0  # re-anchor numerical states this often (integration cost)
    sandbox_max_objects: int = 25  # spawned junk cap per session
    sandbox_max_burns_per_evaluate: int = 3
    sandbox_evaluate_min_interval_s: float = 5.0  # simulated seconds between evaluations unless something changed
    sandbox_unavoidable_retry_s: float = 300.0  # simulated seconds before an unavoidable pass is re-tried

    # --- Perception (demo settings) ---------------------------------------
    perception_enabled: bool = True
    perception_model_meta_path: Path = Path("data/models/perception_risk.meta.json")
    perception_min_horizon_orbits: float = 2.0  # >= the planner's longest lead time
    perception_critical_radius_km: float = 5.0  # same meaning as miss_distance_target_km: inside it, mitigation is needed
    perception_ml_watch_threshold: Optional[float] = None  # None -> operating threshold stored in the model metadata
    perception_full_screen_max_objects: int = 1500  # <= this many objects: physics-screen the whole altitude-filtered set
    perception_screen_top_k: int = 300  # larger catalogs: physics-verify the ML top-K plus the near band
    perception_guaranteed_band_margin_km: float = 10.0
    perception_max_watch_objects: int = 50
    perception_near_field_horizon_s: float = 1800.0  # semi-critical/watch objects are drawn only this far ahead
    perception_trail_half_width_s: float = 90.0
    perception_trail_step_s: float = 5.0
    perception_training_groups: str = "stations,active,cosmos-2251-debris,iridium-33-debris,fengyun-1c-debris"

    @property
    def perception_model_meta_file(self) -> Path:
        p = self.perception_model_meta_path
        return p if p.is_absolute() else REPO_ROOT / p

    @property
    def perception_training_group_list(self) -> List[str]:
        return [g.strip() for g in self.perception_training_groups.split(",") if g.strip()]

    @property
    def cors_origin_list(self) -> List[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def cache_path(self) -> Path:
        p = self.data_cache_dir
        if not p.is_absolute():
            p = REPO_ROOT / p
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def planner_lead_orbit_list(self) -> List[float]:
        return [float(x) for x in self.planner_lead_orbits.split(",") if x.strip()]

    @property
    def planner_dv_list(self) -> List[float]:
        return [float(x) for x in self.planner_dv_magnitudes_mps.split(",") if x.strip()]

    @property
    def planner_direction_list(self) -> List[str]:
        return [x.strip() for x in self.planner_directions.split(",") if x.strip()]

    def default_profile(self) -> PlannerProfile:
        return PlannerProfile("default", tuple(self.planner_lead_orbit_list), tuple(self.planner_dv_list),
                              tuple(self.planner_direction_list), self.planner_max_dv_mps, self.planner_min_lead_time_s)

    def sandbox_profile(self) -> PlannerProfile:
        return PlannerProfile("sandbox", _floats(self.sandbox_lead_orbits), _floats(self.sandbox_dv_magnitudes_mps),
                              _strs(self.sandbox_directions), self.sandbox_max_dv_mps, self.sandbox_min_lead_time_s,
                              require_distance_target=self.sandbox_require_distance_target,
                              earliest_burn_margin_s=self.sandbox_earliest_burn_margin_s,
                              burn_spacing_s=self.sandbox_burn_spacing_s,
                              screening_horizon_orbits=self.sandbox_screening_horizon_orbits)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
