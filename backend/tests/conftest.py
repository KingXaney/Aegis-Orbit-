import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.scenarios import synthetic  # noqa: E402

ISS_TLE = (
    "ISS (ZARYA)",
    "1 25544U 98067A   26290.17683437  .00008767  00000+0  16757-3 0  9994",
    "2 25544  51.6327  56.4129 0006776 273.6806  86.3408 15.48906925590665",
)


@pytest.fixture(scope="session")
def synthetic_catalog():
    return synthetic.build_synthetic_catalog()


@pytest.fixture(scope="session")
def synthetic_window():
    return synthetic.scenario_window()


@pytest.fixture(scope="session")
def synthetic_screening(synthetic_catalog, synthetic_window):
    from app.physics.collision_probability import compute_pc_for_conjunction
    from app.physics.screening import screen
    from app.physics.threat import evaluate_threat_state

    primary = synthetic_catalog.require(synthetic.PRIMARY_ID)
    res = screen(primary, synthetic_catalog.others(synthetic.PRIMARY_ID), synthetic_window["start_unix"],
                 synthetic_window["end_unix"])
    for c in res.conjunctions:
        c.pc = compute_pc_for_conjunction(c, primary, synthetic_catalog.require(c.secondary_id))
        c.threat_state, c.threat_rationale = evaluate_threat_state(c.miss_distance_km, c.pc)
    return res


@pytest.fixture(scope="session")
def synthetic_plan(synthetic_catalog, synthetic_window, synthetic_screening):
    from app.physics.maneuver_planner import plan_maneuvers

    conj = synthetic_screening.conjunctions[0]
    primary = synthetic_catalog.require(conj.primary_id)
    secondary = synthetic_catalog.require(conj.secondary_id)
    return plan_maneuvers(conj, primary, secondary, synthetic_window["start_unix"], max_candidates=3)


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    from app.main import app
    from app.simulation.session import get_store

    get_store().reset(synthetic.SCENARIO_ID)
    get_store().reset(synthetic.SANDBOX_SCENARIO_ID)
    return TestClient(app)
