"""Application configuration.

All thresholds below are *demonstration* settings for this simulator. They are
documented and configurable; none of them is a universal safety standard.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import List, Optional

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", REPO_ROOT / "backend" / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Agent -------------------------------------------------------------
    gemini_api_key: Optional[str] = None
    gemini_model: str = "gemini-2.5-flash"
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


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
