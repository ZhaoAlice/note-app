from __future__ import annotations

from contextlib import asynccontextmanager
import hmac
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.exc import OperationalError

from .config import get_settings
from .book_ocr import start_ocr_worker, stop_ocr_worker
from .routers import attachments, auth, book_categories, books, data, desktop, notes


settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings.attachment_path().mkdir(parents=True, exist_ok=True)
    settings.book_path().mkdir(parents=True, exist_ok=True)
    start_ocr_worker(settings)
    try:
        yield
    finally:
        stop_ocr_worker()


app = FastAPI(title="Note API", version="0.1.0", debug=settings.server.debug, lifespan=lifespan)


@app.middleware("http")
async def require_desktop_token(request: Request, call_next):
    """Keep the loopback API private when it is hosted by the desktop shell."""
    if settings.desktop.enabled and request.url.path.startswith("/api"):
        supplied = request.headers.get("X-Desktop-Token", "")
        if not supplied or not hmac.compare_digest(supplied, settings.desktop.token):
            return JSONResponse(status_code=404, content={"detail": "not found"})
    return await call_next(request)


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
app.include_router(book_categories.router)
app.include_router(books.router)
app.include_router(data.router)
app.include_router(desktop.router)


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
