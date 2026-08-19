from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import AppSettings, BASE_DIR, load_settings


def test_attachment_directory_supports_relative_and_absolute_paths(tmp_path: Path):
    relative = AppSettings(storage={"attachment_dir": "./custom-attachments"})
    assert relative.attachment_path() == (BASE_DIR / "custom-attachments").resolve()

    absolute = AppSettings(storage={"attachment_dir": str(tmp_path)})
    assert absolute.attachment_path() == tmp_path


def test_attachment_directory_supports_environment_override(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("NOTE_STORAGE__ATTACHMENT_DIR", "./environment-attachments")
    assert load_settings().storage.attachment_dir == "./environment-attachments"


def test_book_storage_defaults_paths_and_environment_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    settings = AppSettings(storage={"book_dir": str(tmp_path)})
    assert settings.book_path() == tmp_path
    assert settings.storage.max_book_bytes == 250 * 1024 * 1024
    assert settings.storage.max_cover_bytes == 5 * 1024 * 1024

    monkeypatch.setenv("NOTE_STORAGE__BOOK_DIR", "./environment-books")
    monkeypatch.setenv("NOTE_STORAGE__MAX_BOOK_BYTES", "12345")
    loaded = load_settings()
    assert loaded.storage.book_dir == "./environment-books"
    assert loaded.storage.max_book_bytes == 12345

    with pytest.raises(ValidationError):
        AppSettings(storage={"book_dir": " "})
    with pytest.raises(ValidationError):
        AppSettings(storage={"max_cover_bytes": 0})


def test_attachment_directory_cannot_be_blank():
    with pytest.raises(ValidationError):
        AppSettings(storage={"attachment_dir": "  "})


def test_legacy_upload_directory_field_is_rejected():
    with pytest.raises(ValidationError):
        AppSettings(storage={"upload_dir": "./legacy-uploads"})


def test_allowed_attachment_types_are_normalized_and_validated():
    settings = AppSettings(storage={"allowed_types": {"IMAGE/PNG": [".PNG", ".png"]}})
    assert settings.storage.allowed_types == {"image/png": [".png"]}

    with pytest.raises(ValidationError):
        AppSettings(storage={"allowed_types": {"image/png": ["png"]}})


def test_ocr_configuration_defaults_and_validation():
    settings = AppSettings()
    assert settings.ocr.enabled is True
    assert settings.ocr.concurrency == 1
    assert settings.resolve_path(settings.ocr.model_dir) == (BASE_DIR / "data/ocr-models").resolve()

    with pytest.raises(ValidationError):
        AppSettings(ocr={"model_dir": " "})
    with pytest.raises(ValidationError):
        AppSettings(ocr={"concurrency": 2})
