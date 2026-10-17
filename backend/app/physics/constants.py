"""Physical constants used by the numerical models.

SGP4 internally uses the WGS-72 constants (R_E = 6378.135 km); the numerical
two-body + J2 model uses the WGS-84 values below. The difference is far below
the accuracy of either model for the purposes of this simulator.
"""
MU_EARTH_KM3_S2 = 398600.4418  # Earth gravitational parameter, km^3/s^2
R_EARTH_KM = 6378.137  # WGS-84 equatorial radius, km
J2 = 1.08262668e-3  # Earth second zonal harmonic
EARTH_ROTATION_RATE_RAD_S = 7.2921159e-5
SECONDS_PER_DAY = 86400.0
JD_UNIX_EPOCH = 2440587.5  # Julian date of 1970-01-01T00:00:00Z
