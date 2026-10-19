"""FastAPI application entry point."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from . import __version__
from .api.routes import router
from .config import get_settings
from .simulation import explorer_screening

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Start GPM's screening for the home page in the background; startup doesn't wait for it,
    # and a prewarm failure (e.g. a cold serverless instance) must never take the API down.
    if settings.explorer_prewarm:
        try:
            explorer_screening.warm()
        except Exception as exc:  # noqa: BLE001 - the screening endpoint reports its own errors
            print(f"explorer prewarm failed (continuing without it): {exc}")
    yield


app = FastAPI(
    lifespan=lifespan,
    title="Orbital Collision Avoidance Simulator API",
    version=__version__,
    description=("Physics engine, screening, maneuver planning and AI-agent orchestration for an orbital collision "
                 "avoidance simulation. Research prototype; nothing here commands a spacecraft."),
)

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
