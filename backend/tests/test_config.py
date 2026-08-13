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
