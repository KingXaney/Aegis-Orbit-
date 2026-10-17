import math

import pytest

from app.data.spacecraft import GPM, ISS, KNOWN_DESIGNS_BY_NORAD, design_for, generic_design
from app.data.tle import parse_tle_text
from app.scenarios import real, synthetic

from .conftest import ISS_TLE


def test_iss_uses_published_dimensions():
    obj = parse_tle_text("\n".join(ISS_TLE))[0][0]
    d = obj.design
    assert d.design_id == ISS and d.basis == "PUBLISHED_SPEC"
    assert (d.length_m, d.width_m, d.height_m) == (73.0, 109.0, 20.0)
    assert obj.summary()["design"]["width_m"] == 109.0


@pytest.mark.parametrize("category", ["PAYLOAD", "ROCKET_BODY", "DEBRIS", "UNKNOWN", "SOMETHING_ELSE"])
@pytest.mark.parametrize("radius", [0.5, 2.0, 5.0])
def test_generic_envelope_matches_hard_body_radius(category, radius):
    d = generic_design(category, radius)
    assert d.basis == "SIZED_FROM_HARD_BODY_RADIUS"
    assert math.isclose(d.envelope_radius_m, radius, rel_tol=0.01)


def test_generic_design_follows_radius_changes():
    assert design_for(None, "DEBRIS", 1.0).length_m < design_for(None, "DEBRIS", 3.0).length_m
    assert design_for(99999, "PAYLOAD", 5.0).basis == "SIZED_FROM_HARD_BODY_RADIUS"


def test_iss_hard_body_radius_is_consistent_with_its_envelope():
    iss = KNOWN_DESIGNS_BY_NORAD[25544]
    hbr = real.RADIUS_OVERRIDES_M[real.PRIMARY_ID]
    # the HBR covers the longest dimension (the truss) and stays inside the box's bounding sphere
    assert max(iss.length_m, iss.width_m, iss.height_m) / 2 <= hbr <= iss.envelope_radius_m


def test_synthetic_designs_match_their_hard_body_radius(synthetic_catalog):
    primary = synthetic_catalog.require(synthetic.PRIMARY_ID)
    # the primary is GPM: published design, HBR between half its longest side and its bounding sphere
    assert primary.design == KNOWN_DESIGNS_BY_NORAD[39574] and primary.design.basis == "PUBLISHED_SPEC"
    d = primary.design
    assert max(d.length_m, d.width_m, d.height_m) / 2 <= primary.radius_m <= d.envelope_radius_m
    secondary = synthetic_catalog.require(synthetic.SECONDARY_ID)
    assert secondary.design.basis == "SCENARIO_DEFINITION"
    assert secondary.design.envelope_radius_m <= secondary.radius_m
    for obj in synthetic_catalog.values():
        assert obj.design.length_m > 0 and obj.design.width_m > 0 and obj.design.height_m > 0


def test_gpm_in_the_real_catalog_uses_its_published_design():
    obj = parse_tle_text((real.FIXTURE_TLE).read_text())[0]
    gpm = next(o for o in obj if o.norad_id == 39574)
    assert gpm.design.design_id == GPM and gpm.design.width_m == 13.0
