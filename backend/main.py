"""Deployment entry point: exposes the FastAPI app at the service root.

Serverless runtimes (Vercel's FastAPI preset) import this file directly; it must
be a top-level module so the ``app`` package's relative imports resolve normally.
Local development uses ``uvicorn app.main:app`` and never needs this file.

A serverless instance has about a gigabyte of memory, a slice of one CPU, a
read-only filesystem and no life between requests, so this entry sets the
serverless profile before the app (and numpy) is imported. Explicit environment
variables on the platform still win over these defaults.
"""
import os

# No startup prewarm (it would compete with the first request and die with the instance);
# the home-page screening runs inside the request that needs it, chunked to bound memory.
os.environ.setdefault("EXPLORER_PREWARM", "false")
os.environ.setdefault("EXPLORER_SYNC_SCREENING", "true")
# Serve the committed fixtures; no CelesTrak downloads from a read-only, short-lived instance.
os.environ.setdefault("ALLOW_NETWORK", "false")
# One BLAS/OpenMP thread: on a fractional vCPU, worker threads busy-wait and slow everything down.
for _var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

from app.main import app  # noqa: E402, F401
