"""Perception layer: an ML collision-risk ranker (XGBoost, trained on CelesTrak-derived
screening labels) that selects which catalog objects deserve attention, verified by the
physics screening before anything is displayed."""
from .features import FEATURE_NAMES, FEATURE_VERSION, pair_features  # noqa: F401
from .model import available_libraries, load_risk_model  # noqa: F401
