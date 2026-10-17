"""FastAPI application entry point."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from . import __version__
from .api.routes import router
from .config import get_settings

app = FastAPI(
    title="Orbital Collision Avoidance Simulator API",
    version=__version__,
    description=("Physics engine, screening, maneuver planning and AI-agent orchestration for an orbital collision "
                 "avoidance simulation. Research prototype; nothing here commands a spacecraft."),
)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.include_router(router)


@app.get("/")
def root():
    return {"service": "orbital-avoidance-backend", "version": __version__, "docs": "/docs", "health": "/api/health"}
