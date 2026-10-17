from datetime import datetime, timezone

import pytest

from app.data import explorer_catalog as ec
from app.simulation import explorer_screening as es

GPM = ("GPM-CORE",
       "1 39574U 14009C   26290.55252772  .00006364  00000+0  14243-3 0  9991",
       "2 39574  64.9700 258.0636 0012504 251.7757 108.2023 15.44324678716714")
SCS = ("SCS-01 H",
       "1 63989U 25100H   26290.49169597  .00045460  00000+0  10386-2 0  9990",
       "2 63989  97.3574   7.5758 0007361 187.8886 172.2247 15.42691472 79672")
# With these elements the screening finds a 1.85 km pass at 2026-10-18T00:32:21Z.
TCA = datetime(2026, 10, 18, 0, 32, 21, tzinfo=timezone.utc).timestamp()


@pytest.fixture()
def two_object_catalog(tmp_path, monkeypatch):
    rows = [{"name": n, "tle1": l1, "tle2": l2, "type": "PAYLOAD", "owner": None, "launch_date": None}
            for n, l1, l2 in (GPM, SCS)]
    path = tmp_path / "catalog.json.gz"
    ec.write_rows(path, rows, {"source": "test", "retrieved_at": "2026-10-17T20:37:15Z"})
    monkeypatch.setattr(ec, "_source_path", lambda: (path, "fixture"))
    ec.reset_cache()
    es.reset()
    yield
    ec.reset_cache()
    es.reset()


def test_compute_finds_the_close_pass(two_object_catalog):
    out = es.compute(now_unix=TCA - 3600)
    assert out["primary_norad_id"] == 39574 and out["screened"] == 1
    assert [a["tca_unix"] for a in out["approaches"]] == sorted(a["tca_unix"] for a in out["approaches"])
    a = min(out["approaches"], key=lambda a: a["miss_distance_km"])
    assert a["norad_id"] == 63989 and a["type"] == "PAYLOAD"
    assert abs(a["tca_unix"] - TCA) < 2
    assert 1.5 < a["miss_distance_km"] < 2.2 and 12 < a["relative_speed_kms"] < 13.5
    assert len(a["primary_position_teme_km"]) == 3


def test_endpoint_answers_202_until_ready_then_serves_upcoming_only(two_object_catalog, client, monkeypatch):
    monkeypatch.setattr(es.threading, "Thread", lambda **kw: type("T", (), {"start": lambda self: None})())
    r = client.get("/api/catalog/approaches")
    assert r.status_code == 202 and r.headers["retry-after"] == "3"

    result = es.compute(now_unix=TCA - 3600)
    result["approaches"].append({**result["approaches"][0], "tca_unix": 0.0})  # already passed
    with es._lock:
        es._state.update(result=result, running=False)
    monkeypatch.setattr(es.time, "time", lambda: TCA - 3500)  # the time module, shared with the route
    r = client.get("/api/catalog/approaches")
    assert r.status_code == 200 and r.headers["cache-control"] == "public, max-age=60"
    body = r.json()
    assert body["approaches"] and all(a["tca_unix"] > TCA - 3500 for a in body["approaches"])
    assert "no collision probability" in body["note"]


def test_endpoint_reports_a_failed_screening(two_object_catalog, client):
    with es._lock:
        es._state.update(error="boom", error_at=es.time.time(), running=False)
    r = client.get("/api/catalog/approaches")
    assert r.status_code == 503 and "boom" in r.json()["detail"]
