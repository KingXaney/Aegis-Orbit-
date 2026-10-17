"""Physical design and envelope dimensions of catalog objects.

The globe draws each modelled object at true scale from this record. The
envelope is given in the object's local orbital frame: ``length_m`` along the
velocity (in-track), ``width_m`` across the orbit plane (cross-track) and
``height_m`` along the radial direction. Every design carries a *basis* label,
like the hard-body radius and covariance do:

- ``PUBLISHED_SPEC``: dimensions from the operator's published figures.
- ``SCENARIO_DEFINITION``: dimensions defined by a synthetic scenario.
- ``SIZED_FROM_HARD_BODY_RADIUS``: no published design is known, so a generic
  shape for the object's category is scaled until its envelope's bounding
  sphere matches the hard-body radius.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import Any, Dict, Optional, Tuple

# design_id values the frontend knows how to draw
ISS = "iss"
GPM = "gpm"  # GPM Core Observatory
BOX_WING_BUS = "box-wing-bus"  # bus with two deployable solar arrays
COMPACT_BUS = "compact-bus"  # bus with body-mounted cells, no arrays
ROCKET_BODY = "rocket-body"  # spent upper stage: cylinder, nozzle, interstage
DEBRIS_FRAGMENT = "debris-fragment"


@dataclass(frozen=True)
class SpacecraftDesign:
    design_id: str
    label: str
    length_m: float  # in-track (along velocity)
    width_m: float  # cross-track
    height_m: float  # radial
    basis: str  # PUBLISHED_SPEC | SCENARIO_DEFINITION | SIZED_FROM_HARD_BODY_RADIUS
    reference: str = ""

    @property
    def envelope_radius_m(self) -> float:
        """Radius of the sphere that encloses the envelope box."""
        return 0.5 * math.sqrt(self.length_m ** 2 + self.width_m ** 2 + self.height_m ** 2)

    def as_dict(self) -> Dict[str, Any]:
        return asdict(self)


# Designs with published dimensions, by NORAD catalog number.
KNOWN_DESIGNS_BY_NORAD: Dict[int, SpacecraftDesign] = {
    25544: SpacecraftDesign(
        design_id=ISS, label="International Space Station",
        length_m=73.0, width_m=109.0, height_m=20.0, basis="PUBLISHED_SPEC",
        reference="NASA ISS facts and figures: 109 m integrated truss (cross-track) x 73 m pressurized "
                  "modules (in-track) x about 20 m",
    ),
    39574: SpacecraftDesign(
        design_id=GPM, label="GPM Core Observatory",
        length_m=6.5, width_m=13.0, height_m=5.0, basis="PUBLISHED_SPEC",
        reference="eoPortal GPM: 13 m x 6.5 m x 5 m deployed; 13 m is the solar array span (cross-track), "
                  "the in-track/radial assignment of 6.5 m and 5 m is assumed",
    ),
}

# Envelope proportions (length : width : height) of the generic shape for each category.
CATEGORY_SHAPES: Dict[str, Tuple[str, str, Tuple[float, float, float]]] = {
    "PAYLOAD": (BOX_WING_BUS, "Generic satellite (bus + two solar arrays)", (0.22, 1.0, 0.2)),
    "ROCKET_BODY": (ROCKET_BODY, "Generic spent upper stage", (1.0, 0.32, 0.32)),
    "DEBRIS": (DEBRIS_FRAGMENT, "Generic debris fragment", (1.0, 0.6, 0.25)),
    "UNKNOWN": (COMPACT_BUS, "Unidentified object (compact bus)", (1.0, 0.85, 0.8)),
}


def generic_design(category: str, hard_body_radius_m: float) -> SpacecraftDesign:
    """Category shape scaled so its envelope's bounding sphere has the hard-body radius."""
    design_id, label, (l, w, h) = CATEGORY_SHAPES.get(category, CATEGORY_SHAPES["UNKNOWN"])
    scale = 2.0 * hard_body_radius_m / math.sqrt(l * l + w * w + h * h)
    return SpacecraftDesign(
        design_id=design_id, label=label,
        length_m=round(l * scale, 2), width_m=round(w * scale, 2), height_m=round(h * scale, 2),
        basis="SIZED_FROM_HARD_BODY_RADIUS",
        reference=f"no published design; {category.lower().replace('_', ' ')} shape scaled to the "
                  f"{hard_body_radius_m:g} m hard-body radius",
    )


def design_for(norad_id: Optional[int], category: str, hard_body_radius_m: float) -> SpacecraftDesign:
    if norad_id is not None and norad_id in KNOWN_DESIGNS_BY_NORAD:
        return KNOWN_DESIGNS_BY_NORAD[norad_id]
    return generic_design(category, hard_body_radius_m)
