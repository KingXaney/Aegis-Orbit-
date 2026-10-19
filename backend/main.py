"""Deployment entry point: exposes the FastAPI app at the service root.

Serverless runtimes (Vercel's FastAPI preset) import this file directly; it must
be a top-level module so the ``app`` package's relative imports resolve normally.
Local development uses ``uvicorn app.main:app`` and never needs this file.
"""
from app.main import app  # noqa: F401
