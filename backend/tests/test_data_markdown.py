from __future__ import annotations

import base64
import zipfile
from io import BytesIO
from pathlib import PurePosixPath

from app.config import get_settings

from .conftest import csrf_headers, register


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def _zip(entries: dict[str, bytes]) -> BytesIO:
    output = BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, value in entries.items():
            archive.writestr(path, value)
    output.seek(0)
    return output


def test_markdown_export_and_import_round_trip_with_relative_image(client):
    register(client)
    headers = csrf_headers(client)
    group = client.post("/api/groups", headers=headers, json={"name": "项目"}).json()
    note = client.post(
        "/api/notes",
        headers=headers,
        json={"title": "Windows: 安全?", "group_id": group["id"], "tag_names": ["重要"], "is_pinned": True},
    ).json()
    uploaded = client.post(
        f"/api/notes/{note['id']}/attachments",
        headers=headers,
        files={"file": ("截图.png", BytesIO(PNG_1X1), "image/png")},
    ).json()
    document = {
        "type": "doc",
        "content": [
            {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "正文"}]},
            {"type": "image", "attrs": {"src": uploaded["content_url"], "alt": "图片"}},
        ],
    }
    client.patch(f"/api/notes/{note['id']}", headers=headers, json={"content": document})

    exported = client.get("/api/data/export", params={"format": "markdown"})
    assert exported.status_code == 200, exported.text
    assert "note-markdown-" in exported.headers["content-disposition"]
    with zipfile.ZipFile(BytesIO(exported.content)) as archive:
        markdown_paths = [path for path in archive.namelist() if path.endswith(".md")]
        assert len(markdown_paths) == 1
        assert not any(char in PurePosixPath(markdown_paths[0]).name for char in '<>:"\\|?*')
        markdown = archive.read(markdown_paths[0]).decode()
        assert "title: 'Windows: 安全?'" in markdown
        assert "tags:" in markdown and "重要" in markdown
        assert "group: 项目" in markdown
        assert "![图片](assets/" in markdown
        asset_path = "notes/" + markdown.split("![图片](", 1)[1].split(")", 1)[0]
        assert archive.read(asset_path) == PNG_1X1

    imported = client.post(
        "/api/data/import",
        params={"format": "markdown"},
        headers=headers,
        files={"file": ("notes.zip", BytesIO(exported.content), "application/zip")},
    )
    assert imported.status_code == 200, imported.text
    assert imported.json() == {
        "notes": 1,
        "attachments": 1,
        "books": 0,
        "annotations": 0,
        "renamed": 1,
        "warnings": [],
    }
    imported_note = next(item for item in client.get("/api/notes").json() if item["title"].endswith("（导入）"))
    detail = client.get(f"/api/notes/{imported_note['id']}").json()
    assert detail["group"]["id"] == group["id"]
    assert [tag["name"] for tag in detail["tags"]] == ["重要"]
    image_url = detail["content"]["content"][1]["attrs"]["src"]
    assert image_url != uploaded["content_url"]
    assert client.get(image_url).content == PNG_1X1


def test_single_note_markdown_export_uses_front_matter_and_absolute_image_url(client):
    register(client)
    headers = csrf_headers(client)
    group = client.post("/api/groups", headers=headers, json={"name": "随笔"}).json()
    note = client.post(
        "/api/notes",
        headers=headers,
        json={"title": "单篇:笔记", "group_id": group["id"], "tag_names": ["导出"]},
    ).json()
    uploaded = client.post(
        f"/api/notes/{note['id']}/attachments",
        headers=headers,
        files={"file": ("插图.png", BytesIO(PNG_1X1), "image/png")},
    ).json()
    document = {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "只导出这一篇"}]},
            {"type": "image", "attrs": {"src": uploaded["content_url"], "alt": "插图"}},
        ],
    }
    assert client.patch(f"/api/notes/{note['id']}", headers=headers, json={"content": document}).status_code == 200

    exported = client.get(f"/api/notes/{note['id']}/export", params={"format": "markdown"})
    assert exported.status_code == 200, exported.text
    assert exported.headers["content-type"].startswith("text/markdown")
    assert "filename*=UTF-8''" in exported.headers["content-disposition"]
    assert "title: 单篇:笔记" in exported.text
    assert "tags:" in exported.text and "导出" in exported.text
    assert "group: 随笔" in exported.text
    assert "只导出这一篇" in exported.text
    assert f"![插图](http://testserver/api/attachments/{uploaded['id']}/content)" in exported.text

    assert client.post("/api/auth/logout", headers=headers).status_code == 204
    register(client, "another-user")
    assert client.get(f"/api/notes/{note['id']}/export", params={"format": "markdown"}).status_code == 404


def test_single_markdown_import_uses_front_matter_and_reports_remote_images(client):
    register(client)
    markdown = b"""---
title: Front matter title
tags: [one, two]
group: Inbox
is_pinned: true
created_at: 2026-08-01T01:02:03Z
updated_at: 2026-08-02T01:02:03Z
---

# Heading stays in the body

![remote](https://example.com/image.png)
"""
    response = client.post(
        "/api/data/import",
        params={"format": "markdown"},
        headers=csrf_headers(client),
        files={"file": ("single.md", BytesIO(markdown), "text/markdown")},
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["notes"] == 1
    assert result["attachments"] == result["renamed"] == 0
    assert any("remote image" in warning for warning in result["warnings"])
    note = client.get("/api/notes").json()[0]
    assert note["title"] == "Front matter title"
    assert note["group"]["name"] == "Inbox"
    assert note["is_pinned"] is True
    assert [tag["name"] for tag in note["tags"]] == ["one", "two"]
    detail = client.get(f"/api/notes/{note['id']}").json()
    assert detail["content"]["content"][0]["type"] == "heading"


def test_markdown_zip_uses_h1_title_top_directory_group_and_relative_image(client):
    register(client)
    markdown = "# 山中照片\n\n说明\n\n![景色](assets/pixel.png)\n".encode()
    archive = _zip({"旅行/照片.md": markdown, "旅行/assets/pixel.png": PNG_1X1})
    response = client.post(
        "/api/data/import",
        params={"format": "markdown"},
        headers=csrf_headers(client),
        files={"file": ("travel.zip", archive, "application/zip")},
    )
    assert response.status_code == 200, response.text
    assert response.json() == {
        "notes": 1,
        "attachments": 1,
        "books": 0,
        "annotations": 0,
        "renamed": 0,
        "warnings": [],
    }
    note = client.get("/api/notes").json()[0]
    assert note["title"] == "山中照片"
    assert note["group"]["name"] == "旅行"
    detail = client.get(f"/api/notes/{note['id']}").json()
    assert all(node["type"] != "heading" for node in detail["content"]["content"])
    assert client.get(detail["attachments"][0]["content_url"]).content == PNG_1X1


def test_markdown_zip_rejects_unsafe_paths(client):
    register(client)
    response = client.post(
        "/api/data/import",
        params={"format": "markdown"},
        headers=csrf_headers(client),
        files={"file": ("unsafe.zip", _zip({"../evil.md": b"# bad"}), "application/zip")},
    )
    assert response.status_code == 422
    assert "unsafe" in response.json()["detail"]


def test_markdown_import_failure_rolls_back_database_and_files(client):
    register(client)
    archive = _zip(
        {
            "a.md": b"# First\n\n![ok](assets/ok.png)\n",
            "assets/ok.png": PNG_1X1,
            "b.md": b"# Second\n\n![broken](assets/broken.png)\n",
            "assets/broken.png": b"not a PNG",
        }
    )
    response = client.post(
        "/api/data/import",
        params={"format": "markdown"},
        headers=csrf_headers(client),
        files={"file": ("broken.zip", archive, "application/zip")},
    )
    assert response.status_code == 422
    assert client.get("/api/notes").json() == []
    assert list(get_settings().attachment_path().iterdir()) == []
