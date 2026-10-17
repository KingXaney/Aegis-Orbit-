import numpy as np

from app.data.tle import flag_stale, infer_category, object_from_tle, parse_tle_text, tle_checksum, validate_tle_lines
from tests.conftest import ISS_TLE


def _fix_checksum(line: str) -> str:
    return line[:68] + str(tle_checksum(line))


def test_valid_tle_parses_with_provenance():
    objs, rejected = parse_tle_text("\n".join(ISS_TLE), source_detail="GROUP=stations")
    assert len(objs) == 1 and not rejected
    o = objs[0]
    assert o.object_id == "NORAD-25544" and o.norad_id == 25544
    assert o.category == "PAYLOAD" and o.category_basis == "INFERRED_FROM_NAME"
    assert o.epoch.year == 2026 and o.epoch.month == 10 and o.epoch.day == 17
    assert o.propagation_model == "SGP4" and o.position_basis == "PROPAGATED_FROM_GP_ELEMENTS"
    assert 400 < o.perigee_alt_km < o.apogee_alt_km < 440
    assert 5400 < o.period_s < 5700 and abs(o.inclination_deg - 51.6327) < 1e-3
    assert o.covariance_source == "UNAVAILABLE" and o.radius_basis == "ASSUMED_DEFAULT"


def test_checksum_mismatch_is_rejected():
    bad_line1 = ISS_TLE[1][:68] + "0"
    objs, rejected = parse_tle_text("\n".join([ISS_TLE[0], bad_line1, ISS_TLE[2]]))
    assert not objs and len(rejected) == 1
    assert "checksum" in rejected[0]["reason"]


def test_unpaired_and_short_lines_are_rejected():
    objs, rejected = parse_tle_text("\n".join([ISS_TLE[0], ISS_TLE[1]]))
    assert not objs and rejected and "unpaired" in rejected[0]["reason"]
    problems = validate_tle_lines("1 25544U", ISS_TLE[2])
    assert any("shorter" in p for p in problems)


def test_two_line_format_without_name():
    objs, rejected = parse_tle_text("\n".join(ISS_TLE[1:]))
    assert len(objs) == 1 and objs[0].name == "OBJECT 25544"


def test_category_inference():
    assert infer_category("COSMOS 2251 DEB") == "DEBRIS"
    assert infer_category("SL-16 R/B") == "ROCKET_BODY"
    assert infer_category("STARLINK-1234") == "PAYLOAD"


def test_suborbital_record_is_rejected():
    # mean motion 17.5 rev/day => semi-major axis below the Earth's radius
    line2 = ISS_TLE[2][:52] + "17.50000000590665"
    line2 = _fix_checksum(line2)
    obj, rej = object_from_tle("BOGUS", ISS_TLE[1], line2)
    assert obj is None and rej is not None and "SGP4 error" in rej["reason"]


def test_stale_flagging():
    objs, _ = parse_tle_text("\n".join(ISS_TLE))
    flag_stale(objs, objs[0].epoch.timestamp() + 45 * 86400, max_age_days=30)
    assert objs[0].validation_status == "STALE" and objs[0].warnings
