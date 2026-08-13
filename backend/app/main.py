from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.exc import OperationalError

from .config import get_settings
from .routers import attachments, auth, notes


settings = get_settings()
app = FastAPI(title="Note API", version="0.1.0", debug=settings.server.debug)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.server.trusted_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth.router)
app.include_router(notes.router)
app.include_router(attachments.router)


@app.exception_handler(OperationalError)
def database_unavailable(_request: Request, _exception: OperationalError) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": "database temporarily unavailable"})


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


frontend_dist = settings.resolve_path(settings.server.frontend_dist)
if frontend_dist.is_dir():
    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str) -> FileResponse:
        requested = (frontend_dist / path).resolve()
        if path and requested.is_file() and requested.is_relative_to(frontend_dist):
            return FileResponse(requested)
        index = frontend_dist / "index.html"
        if not index.is_file():
            raise HTTPException(404, "frontend build not found")
        return FileResponse(index)

