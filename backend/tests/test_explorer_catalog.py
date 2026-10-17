import gzip
import json

import pytest

from app.data import explorer_catalog as ec
from app.data.satcat import parse_satcat_csv

from .conftest import ISS_TLE

DEB_TLE = (
    "COSMOS 2251 DEB",
    "1 35602U 93036AMV 26290.09282193  .00022736  00000+0  39822-3 0  9996",
    "2 35602  73.9897 231.9616 0068403 215.4338 156.9135 15.47846245948441",
)

SATCAT_CSV = """OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE
ISS (ZARYA),1998-067A,25544,PAY,+,ISS,1998-11-20,TYMSC,,92.90,51.63,420,415,399.0524,,EA,ORB
COSMOS 2251 DEB,1993-036AMV,35602,UNK,,CIS,1993-06-16,PKMTR,,93.0,74.0,500,400,,,EA,ORB
SPUTNIK 1,1957-001B,2,PAY,D,CIS,1957-10-04,TYMSC,1958-01-03,96.10,65.00,1080,64,,,EA,IMP
"""


def _tle_text(*tles):
    return "\n".join("\n".join(t) for t in tles) + "\n"


@pytest.mark.parametrize("perigee, apogee, period_min, expected", [
    (415.0, 422.0, 92.9, "LEO"),            # ISS
    (20_100.0, 20_260.0, 717.9, "MEO"),     # GPS
    (35_780.0, 35_795.0, 1436.1, "GEO"),    # geostationary
    (600.0, 39_700.0, 717.7, "HEO"),        # Molniya
    (250.0, 35_900.0, 630.0, "HEO"),        # GTO rocket body
    (1_200.0, 2_500.0, 119.0, "MEO"),       # just above the LEO apogee limit, near-circular
])
def test_classify_orbit(perigee, apogee, period_min, expected):
    assert ec.classify_orbit(perigee, apogee, period_min * 60.0) == expected


def test_parse_satcat_csv():
    recs = parse_satcat_csv(SATCAT_CSV)
    assert recs[25544].category == "PAYLOAD" and recs[25544].owner == "ISS"
    assert recs[25544].launch_date == "1998-11-20" and recs[25544].decay_date is None
    assert recs[35602].category == "UNKNOWN"
    assert recs[2].decay_date == "1958-01-03"


def test_join_dedupes_and_prefers_satcat_type():
    satcat = parse_satcat_csv(SATCAT_CSV)
    texts = {"active": _tle_text(ISS_TLE), "debris": _tle_text(DEB_TLE, ISS_TLE)}
    rows, stats = ec.join_rows(texts, satcat)
    assert len(rows) == 2 and stats["parsed"] == 3
    by_name = {r["name"]: r for r in rows}
    assert by_name["ISS (ZARYA)"]["query"] == "active"
    assert by_name["ISS (ZARYA)"]["type"] == "PAYLOAD" and by_name["ISS (ZARYA)"]["type_basis"] == "SATCAT"
    objs, rejected = ec.catalog_objects(rows)
    assert rejected == 0
    deb = next(o for o in objs if o["norad_id"] == 35602)
    assert deb["type"] == "DEBRIS" and deb["owner"] == "CIS" and deb["orbit_class"] == "LEO"


def test_join_falls_back_to_name_without_satcat():
    rows, stats = ec.join_rows({"debris": _tle_text(DEB_TLE)}, {})
    assert rows[0]["type"] == "DEBRIS" and rows[0]["type_basis"] == "INFERRED_FROM_NAME"
    assert stats["without_satcat"] == 1


def test_catalog_endpoint(client, tmp_path, monkeypatch):
    rows, _ = ec.join_rows({"active": _tle_text(ISS_TLE), "debris": _tle_text(DEB_TLE)}, parse_satcat_csv(SATCAT_CSV))
    path = tmp_path / "catalog.json.gz"
    ec.write_rows(path, rows, {"source": "test", "retrieved_at": "2026-10-17T00:00:00Z"})
    monkeypatch.setattr(ec, "_source_path", lambda: (path, "fixture"))
    ec.reset_cache()
    try:
        r = client.get("/api/catalog", headers={"Accept-Encoding": "gzip"})
        assert r.status_code == 200 and r.headers.get("content-encoding") == "gzip"
        body = r.json()
        assert body["total"] == 2 and body["counts_by_type"] == {"PAYLOAD": 1, "DEBRIS": 1}
        iss = next(o for o in body["objects"] if o["norad_id"] == 25544)
        assert iss["orbit_class"] == "LEO" and 51 < iss["inclination_deg"] < 52 and 90 < iss["period_min"] < 95
        assert iss["tle1"] == ISS_TLE[1] and iss["launch_date"] == "1998-11-20"
    finally:
        ec.reset_cache()


def test_fixture_is_valid_when_present():
    if not ec.FIXTURE_PATH.exists():
        pytest.skip("fixture not built")
    with gzip.open(ec.FIXTURE_PATH, "rt", encoding="utf-8") as fh:
        data = json.load(fh)
    assert len(data["objects"]) > 10_000
    assert {r["type"] for r in data["objects"]} >= {"PAYLOAD", "DEBRIS", "ROCKET_BODY"}
