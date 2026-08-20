from __future__ import annotations

import argparse
import json
import logging
import subprocess
import re
import sys
import threading
import uuid
from datetime import timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import and_, or_, select, update
from sqlalchemy.orm import Session

from .config import AppSettings, get_settings
from .database import SessionLocal
from .models import Book, BookOcrJob, BookTextUnit, utcnow


LOGGER = logging.getLogger(__name__)
LEASE_SECONDS = 120
POLL_SECONDS = 2.0
MIN_NATIVE_TEXT_CHARS = 40
PDF_RENDER_SCALE = 2.0
MAX_RENDER_DIMENSION = 2400


def _ocr_enabled(settings: AppSettings) -> bool:
    ocr = getattr(settings, "ocr", None)
    return bool(getattr(ocr, "enabled", True))


def _model_parameters(settings: AppSettings) -> dict[str, Any]:
    ocr = getattr(settings, "ocr", None)
    configured = getattr(ocr, "model_dir", None)
    if not configured:
        return {}
    model_root = settings.resolve_path(configured)
    model_root.mkdir(parents=True, exist_ok=True)
    return {"Global.model_root_dir": str(model_root)}


def prepare_ocr_models(settings: AppSettings | None = None) -> None:
    """Load the configured OCR model once so setup can prepare an offline runtime."""
    settings = settings or get_settings()
    if not _ocr_enabled(settings):
        return
    from rapidocr import RapidOCR

    RapidOCR(params=_model_parameters(settings))


def _meaningful_text(value: str) -> bool:
    return len(re.sub(r"\s+", "", value)) >= MIN_NATIVE_TEXT_CHARS


def _ocr_lines(result: Any, width: int, height: int) -> tuple[str, list[dict[str, Any]]]:
    result_texts = getattr(result, "txts", None)
    result_boxes = getattr(result, "boxes", None)
    result_scores = getattr(result, "scores", None)
    texts = list(result_texts) if result_texts is not None else []
    raw_boxes = list(result_boxes) if result_boxes is not None else []
    scores = list(result_scores) if result_scores is not None else []
    if not texts and isinstance(result, (tuple, list)) and result:
        rows = result[0] or []
        texts = [str(row[1]) for row in rows]
        raw_boxes = [row[0] for row in rows]
        scores = [float(row[2]) for row in rows]
    boxes: list[dict[str, Any]] = []
    for index, text in enumerate(texts):
        if index >= len(raw_boxes):
            break
        points = raw_boxes[index]
        xs = [float(point[0]) for point in points]
        ys = [float(point[1]) for point in points]
        if not xs or not ys or width <= 0 or height <= 0:
            continue
        left, right = min(xs), max(xs)
        top, bottom = min(ys), max(ys)
        boxes.append(
            {
                "text": text,
                "score": round(float(scores[index]) if index < len(scores) else 0.0, 6),
                "left": round(max(0.0, left / width * 100), 6),
                "top": round(max(0.0, top / height * 100), 6),
                "width": round(max(0.0, min(100.0, (right - left) / width * 100)), 6),
                "height": round(max(0.0, min(100.0, (bottom - top) / height * 100)), 6),
            }
        )
    return "\n".join(texts), boxes


def _claim_job() -> tuple[str, str] | None:
    now = utcnow()
    claimable = or_(
        BookOcrJob.status == "queued",
        and_(BookOcrJob.status == "running", BookOcrJob.lease_until < now),
    )
    with SessionLocal() as db:
        candidates = list(
            db.scalars(
                select(BookOcrJob.book_id)
                .where(claimable)
                .order_by(BookOcrJob.updated_at, BookOcrJob.book_id)
                .limit(8)
            ).all()
        )
        for book_id in candidates:
            token = uuid.uuid4().hex
            claimed = db.execute(
                update(BookOcrJob)
                .where(BookOcrJob.book_id == book_id, claimable)
                .values(
                    status="running",
                    claim_token=token,
                    lease_until=now + timedelta(seconds=LEASE_SECONDS),
                    error=None,
                    updated_at=now,
                )
            )
            if claimed.rowcount == 1:
                db.commit()
                return book_id, token
            db.rollback()
    return None


def _update_job(
    db: Session,
    book_id: str,
    token: str,
    *,
    status: str | None = None,
    pages_total: int | None = None,
    pages_done: int | None = None,
    error: str | None = None,
) -> BookOcrJob:
    job = db.scalar(
        select(BookOcrJob).where(BookOcrJob.book_id == book_id, BookOcrJob.claim_token == token)
    )
    if job is None:
        raise RuntimeError("OCR job lease was lost")
    if status is not None:
        job.status = status
    if pages_total is not None:
        job.pages_total = pages_total
    if pages_done is not None:
        job.pages_done = pages_done
    job.error = error
    job.lease_until = utcnow() + timedelta(seconds=LEASE_SECONDS) if job.status == "running" else None
    job.updated_at = utcnow()
    return job


def _store_text_unit(
    db: Session,
    book_id: str,
    page_index: int,
    text: str,
    source: str,
    boxes: list[dict[str, Any]] | None,
) -> None:
    unit = db.scalar(
        select(BookTextUnit).where(
            BookTextUnit.book_id == book_id,
            BookTextUnit.unit_index == page_index,
        )
    )
    if unit is None:
        unit = BookTextUnit(book_id=book_id, unit_index=page_index, locator="{}")
        db.add(unit)
    unit.locator = json.dumps(
        {"kind": "pdf", "page_index": page_index}, ensure_ascii=False, separators=(",", ":")
    )
    unit.text = text
    unit.boxes = (
        json.dumps(boxes, ensure_ascii=False, separators=(",", ":")) if boxes is not None else None
    )
    unit.source = source
    unit.label = f"第 {page_index + 1} 页"


def _process_pdf(book_id: str, token: str, settings: AppSettings) -> None:
    import pypdfium2 as pdfium
    from rapidocr import RapidOCR

    engine: Any | None = None
    with SessionLocal() as db:
        book = db.scalar(select(Book).where(Book.id == book_id))
        if book is None or book.format != "pdf":
            _update_job(db, book_id, token, status="failed", error="PDF 书籍不存在")
            db.commit()
            return
        source_name = book.reader_storage_name if book.storage_mode == "linked" else book.storage_name
        source_path = settings.book_path() / source_name if source_name else settings.book_path() / ".missing"
        if not source_path.is_file():
            _update_job(db, book_id, token, status="failed", error="PDF 原文件缺失")
            db.commit()
            return

    document = pdfium.PdfDocument(str(source_path))
    try:
        pages_total = len(document)
        if pages_total <= 0:
            raise ValueError("PDF 没有可读取页面")
        with SessionLocal() as db:
            job = _update_job(db, book_id, token, pages_total=pages_total)
            start_page = min(max(job.pages_done, 0), pages_total)
            book = db.get(Book, book_id)
            if book is not None:
                book.page_count = pages_total
            db.commit()

        for page_index in range(start_page, pages_total):
            page = document[page_index]
            try:
                text_page = page.get_textpage()
                try:
                    native_text = (text_page.get_text_range() or "").strip()
                finally:
                    text_page.close()
                if _meaningful_text(native_text):
                    text, source, boxes = native_text, "native", None
                else:
                    if engine is None:
                        engine = RapidOCR(params=_model_parameters(settings))
                    page_width, page_height = page.get_size()
                    render_scale = min(
                        PDF_RENDER_SCALE,
                        MAX_RENDER_DIMENSION / max(float(page_width), float(page_height), 1.0),
                    )
                    bitmap = page.render(scale=render_scale)
                    try:
                        image = bitmap.to_pil()
                        result = engine(image)
                        text, boxes = _ocr_lines(result, image.width, image.height)
                    finally:
                        bitmap.close()
                    source = "ocr"
            finally:
                page.close()
            with SessionLocal() as db:
                _store_text_unit(db, book_id, page_index, text, source, boxes)
                _update_job(db, book_id, token, pages_total=pages_total, pages_done=page_index + 1)
                db.commit()

        with SessionLocal() as db:
            job = _update_job(
                db,
                book_id,
                token,
                status="completed",
                pages_total=pages_total,
                pages_done=pages_total,
                error=None,
            )
            job.claim_token = None
            db.commit()
    finally:
        document.close()


def _fail_job(book_id: str, token: str, exc: Exception) -> None:
    LOGGER.exception("OCR failed for book %s", book_id)
    message = str(exc).strip() or exc.__class__.__name__
    with SessionLocal() as db:
        job = db.scalar(
            select(BookOcrJob).where(BookOcrJob.book_id == book_id, BookOcrJob.claim_token == token)
        )
        if job is None:
            return
        job.status = "failed"
        job.error = message[:1000]
        job.claim_token = None
        job.lease_until = None
        job.updated_at = utcnow()
        db.commit()


def process_claimed_job(book_id: str, token: str) -> int:
    """Run one claimed OCR job in an isolated process."""
    try:
        _process_pdf(book_id, token, get_settings())
    except Exception as exc:
        _fail_job(book_id, token, exc)
        return 1
    return 0


def _job_command(book_id: str, token: str) -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, "--ocr-job", book_id, "--ocr-token", token]
    return [sys.executable, "-m", "app.book_ocr", "--job", book_id, "--token", token]


class OcrWorker:
    def __init__(self, settings: AppSettings):
        self.settings = settings
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._process: subprocess.Popen[bytes] | None = None

    def start(self) -> None:
        if not _ocr_enabled(self.settings) or self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="book-ocr", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        process = self._process
        if process is not None and process.poll() is None:
            process.terminate()
        if self._thread is not None:
            self._thread.join(timeout=10)
            self._thread = None
        process = self._process
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        self._process = None

    def wake(self) -> None:
        self._wake.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                claimed = _claim_job()
            except Exception:
                LOGGER.exception("OCR worker could not poll the job queue")
                self._wake.wait(POLL_SECONDS)
                self._wake.clear()
                continue
            if claimed is None:
                self._wake.wait(POLL_SECONDS)
                self._wake.clear()
                continue
            book_id, token = claimed
            try:
                self._process = subprocess.Popen(
                    _job_command(book_id, token),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                while self._process.poll() is None and not self._stop.wait(0.2):
                    pass
                if self._stop.is_set() and self._process.poll() is None:
                    self._process.terminate()
                self._process.wait(timeout=10)
            except Exception as exc:  # pragma: no cover - exercised through failure-state assertions
                _fail_job(book_id, token, exc)
            finally:
                self._process = None


_worker: OcrWorker | None = None


def start_ocr_worker(settings: AppSettings | None = None) -> None:
    global _worker
    if _worker is None:
        _worker = OcrWorker(settings or get_settings())
    _worker.start()


def stop_ocr_worker() -> None:
    global _worker
    if _worker is not None:
        _worker.stop()
        _worker = None


def wake_ocr_worker() -> None:
    if _worker is not None:
        _worker.wake()


def _main() -> None:
    parser = argparse.ArgumentParser(description="Prepare local OCR models for the book reader")
    parser.add_argument("--prepare", action="store_true", help="download/load configured OCR models")
    parser.add_argument("--job")
    parser.add_argument("--token")
    args = parser.parse_args()
    if args.prepare:
        prepare_ocr_models()
        return
    if args.job and args.token:
        raise SystemExit(process_claimed_job(args.job, args.token))
    parser.error("use --prepare or --job with --token")


if __name__ == "__main__":
    _main()
