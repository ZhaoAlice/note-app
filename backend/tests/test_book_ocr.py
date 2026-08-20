from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app import book_ocr
from app.config import get_settings
from app.database import Base
from app.models import Book, BookOcrJob, BookTextUnit, User
from app.routers.books import get_book_page_text


class _FakeTextPage:
    def get_text_range(self):
        return ""

    def close(self):
        return None


class _FakeImage:
    width = 200
    height = 100


class _FakeBitmap:
    def to_pil(self):
        return _FakeImage()

    def close(self):
        return None


class _FakePage:
    def get_size(self):
        return 200, 100

    def get_textpage(self):
        return _FakeTextPage()

    def render(self, scale):
        assert scale == book_ocr.PDF_RENDER_SCALE
        return _FakeBitmap()

    def close(self):
        return None


class _FakeDocument:
    expected_name = "scan.pdf"

    def __init__(self, path):
        assert Path(path).is_file()
        assert Path(path).name == self.expected_name

    def __len__(self):
        return 1

    def __getitem__(self, index):
        assert index == 0
        return _FakePage()

    def close(self):
        return None


class _FakeRapidOCR:
    def __init__(self, params=None):
        assert isinstance(params, dict)

    def __call__(self, _image):
        return SimpleNamespace(
            txts=("扫描文字",),
            boxes=([[10, 20], [110, 20], [110, 40], [10, 40]],),
            scores=(0.95,),
        )


@pytest.mark.parametrize(
    ("storage_mode", "storage_name", "reader_storage_name", "expected_name"),
    [
        ("managed", "scan.pdf", "safe.pdf", "scan.pdf"),
        ("linked", None, "safe.pdf", "safe.pdf"),
    ],
)
def test_ocr_worker_claims_scanned_pdf_and_persists_normalized_boxes(
    tmp_path, monkeypatch, storage_mode, storage_name, reader_storage_name, expected_name
):
    engine = create_engine(f"sqlite:///{(tmp_path / 'ocr.db').as_posix()}")
    TestingSession = sessionmaker(bind=engine, expire_on_commit=False)
    Base.metadata.create_all(engine)
    settings = get_settings()
    previous_book_dir = settings.storage.book_dir
    settings.storage.book_dir = str(tmp_path / "books")
    settings.book_path().mkdir(parents=True)
    (settings.book_path() / "scan.pdf").write_bytes(b"%PDF-fake")
    (settings.book_path() / "safe.pdf").write_bytes(b"%PDF-safe")
    _FakeDocument.expected_name = expected_name
    try:
        with TestingSession() as db:
            user = User(username="ocr", normalized_username="ocr", password_hash="test")
            db.add(user)
            db.flush()
            book = Book(
                user_id=user.id,
                title="扫描书",
                author=None,
                format="pdf",
                original_name="scan.pdf",
                storage_mode=storage_mode,
                storage_name=storage_name,
                reader_storage_name=reader_storage_name,
                sha256="0" * 64,
                size=9,
                search_text="扫描书",
            )
            db.add(book)
            db.flush()
            db.add(BookOcrJob(book_id=book.id, status="queued"))
            db.commit()
            book_id = book.id

        monkeypatch.setattr(book_ocr, "SessionLocal", TestingSession)
        monkeypatch.setitem(sys.modules, "pypdfium2", SimpleNamespace(PdfDocument=_FakeDocument))
        monkeypatch.setitem(sys.modules, "rapidocr", SimpleNamespace(RapidOCR=_FakeRapidOCR))

        claimed = book_ocr._claim_job()
        assert claimed is not None and claimed[0] == book_id
        book_ocr._process_pdf(*claimed, settings)

        with TestingSession() as db:
            job = db.get(BookOcrJob, book_id)
            assert job is not None
            assert (job.status, job.pages_done, job.pages_total) == ("completed", 1, 1)
            unit = db.scalar(select(BookTextUnit).where(BookTextUnit.book_id == book_id))
            assert unit is not None and unit.text == "扫描文字" and unit.source == "ocr"
            box = json.loads(unit.boxes)[0]
            assert box == {
                "text": "扫描文字",
                "score": 0.95,
                "left": 5.0,
                "top": 20.0,
                "width": 50.0,
                "height": 20.0,
            }
            page_text = get_book_page_text(
                book_id,
                0,
                auth=SimpleNamespace(user=db.get(User, unit.book.user_id)),
                db=db,
            )
            assert page_text.source == "ocr"
            assert page_text.boxes[0].text == "扫描文字"
    finally:
        settings.storage.book_dir = previous_book_dir
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_ocr_job_command_uses_a_separate_python_process(monkeypatch):
    monkeypatch.setattr(book_ocr.sys, "frozen", False, raising=False)

    command = book_ocr._job_command("book-1", "claim-token")

    assert command == [
        sys.executable,
        "-m",
        "app.book_ocr",
        "--job",
        "book-1",
        "--token",
        "claim-token",
    ]


def test_frozen_ocr_job_command_reuses_the_sidecar_executable(monkeypatch):
    monkeypatch.setattr(book_ocr.sys, "frozen", True, raising=False)

    command = book_ocr._job_command("book-1", "claim-token")

    assert command == [sys.executable, "--ocr-job", "book-1", "--ocr-token", "claim-token"]
