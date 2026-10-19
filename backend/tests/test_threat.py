from app.config import Settings
from app.physics.collision_probability import PcResult
from app.physics.threat import evaluate_threat_state, meets_mitigation_target, worst_state

S = Settings()


def _pc(value, basis="PROVIDED"):
    return PcResult(status="COMPUTED", value=value, covariance_basis=basis, hard_body_radius_m=10.0,
                    hard_body_radius_basis="test", miss_distance_m=100.0)


def test_states_from_pc():
    assert evaluate_threat_state(0.1, _pc(5e-4), S)[0] == "CRITICAL"
    assert evaluate_threat_state(0.1, _pc(5e-5), S)[0] == "ELEVATED"
    assert evaluate_threat_state(0.1, _pc(1e-7), S)[0] == "MONITORING"


def test_states_without_pc():
    unverified = PcResult(status="UNVERIFIED", value=None, covariance_basis="UNAVAILABLE", hard_body_radius_m=10.0,
                          hard_body_radius_basis="t", miss_distance_m=500.0, reason="none")
    assert evaluate_threat_state(0.5, unverified, S)[0] == "UNVERIFIED"
    assert evaluate_threat_state(15.0, unverified, S)[0] == "MONITORING"
    assert evaluate_threat_state(2.0, None, S)[0] == "UNVERIFIED"


def test_mitigation_target():
    assert meets_mitigation_target(1.0, _pc(1e-8), S)[0]
    assert not meets_mitigation_target(1.0, _pc(1e-5), S)[0]
    ok, basis = meets_mitigation_target(6.0, None, S)
    assert ok and "distance-based" in basis
    assert not meets_mitigation_target(2.0, None, S)[0]


def test_worst_state_ordering():
    assert worst_state(["MONITORING", "CRITICAL", "ELEVATED"]) == "CRITICAL"
    assert worst_state(["MONITORING", "UNVERIFIED"]) == "UNVERIFIED"
    assert worst_state([]) == "NORMAL"
