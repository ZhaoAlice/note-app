from __future__ import annotations

import base64
import hashlib
import json
import zipfile
from io import BytesIO

import pytest

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


def _rewrite_backup(payload: bytes, mutate) -> BytesIO:
    with zipfile.ZipFile(BytesIO(payload)) as archive:
        entries = {info.filename: archive.read(info.filename) for info in archive.infolist() if not info.is_dir()}
    manifest = json.loads(entries["manifest.json"])
    mutate(manifest, entries)
    entries["manifest.json"] = json.dumps(manifest).encode()
    return _zip(entries)


def _set_text_reading_state(client, headers: dict[str, str], book_id: str) -> None:
    response = client.put(
        f"/api/books/{book_id}/reading-state",
        headers=headers,
        json={"locator": {"kind": "text", "start": 0, "end": 0}},
    )
    assert response.status_code == 200, response.text


def test_backup_export_and_non_overwriting_import_round_trip(client):
    register(client)
    headers = csrf_headers(client)
    group = client.post("/api/groups", headers=headers, json={"name": "资料"}).json()
    note = client.post(
        "/api/notes",
        headers=headers,
        json={"title": "图片笔记", "group_id": group["id"], "tag_names": ["收藏"], "is_pinned": True},
    ).json()
    uploaded = client.post(
        f"/api/notes/{note['id']}/attachments",
        headers=headers,
        files={"file": ("像素.png", BytesIO(PNG_1X1), "image/png")},
    ).json()
    content = {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "正文"}]},
            {"type": "image", "attrs": {"src": uploaded["content_url"]}},
        ],
    }
    assert client.patch(f"/api/notes/{note['id']}", headers=headers, json={"content": content}).status_code == 200

    exported = client.get("/api/data/export", params={"format": "backup"})
    assert exported.status_code == 200, exported.text
    assert exported.headers["content-type"] == "application/zip"
    assert "note-backup-" in exported.headers["content-disposition"]
    with zipfile.ZipFile(BytesIO(exported.content)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["format"] == "note-backup"
        assert manifest["version"] == 3
        assert manifest["books"] == []
        assert manifest["book_categories"] == []
        assert len(manifest["groups"]) == len(manifest["tags"]) == len(manifest["notes"]) == 1
        note_record = json.loads(archive.read(manifest["notes"][0]["path"]))
        assert note_record["content"] == content
        assert archive.read(note_record["attachments"][0]["path"]) == PNG_1X1

    imported = client.post(
        "/api/data/import",
        params={"format": "backup"},
        headers=headers,
        files={"file": ("backup.zip", BytesIO(exported.content), "application/zip")},
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
    notes = client.get("/api/notes").json()
    assert {item["title"] for item in notes} == {"图片笔记", "图片笔记（导入）"}
    imported_summary = next(item for item in notes if item["title"] == "图片笔记（导入）")
    imported_note = client.get(f"/api/notes/{imported_summary['id']}").json()
    assert imported_note["group"]["id"] == group["id"]
    assert [item["name"] for item in imported_note["tags"]] == ["收藏"]
    imported_src = imported_note["content"]["content"][1]["attrs"]["src"]
    assert imported_src != uploaded["content_url"]
    assert client.get(imported_src).content == PNG_1X1
    assert len(client.get("/api/groups").json()) == 1
    assert len(client.get("/api/tags").json()) == 1


def test_backup_endpoints_require_authentication_and_csrf(client):
    assert client.get("/api/data/export", params={"format": "backup"}).status_code == 401
    register(client)
    assert client.post(
        "/api/data/import",
        params={"format": "backup"},
        files={"file": ("backup.zip", _zip({"manifest.json": b"{}"}), "application/zip")},
    ).status_code == 403


def test_backup_export_contains_only_current_user_data(client):
    register(client, "alice")
    alice_headers = csrf_headers(client)
    client.post("/api/notes", headers=alice_headers, json={"title": "Alice 私有"})
    assert client.post("/api/auth/logout", headers=alice_headers).status_code == 204
    register(client, "bob")
    client.post("/api/notes", headers=csrf_headers(client), json={"title": "Bob 私有"})

    exported = client.get("/api/data/export", params={"format": "backup"})
    with zipfile.ZipFile(BytesIO(exported.content)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert len(manifest["notes"]) == 1
        note = json.loads(archive.read(manifest["notes"][0]["path"]))
        assert note["title"] == "Bob 私有"


def test_backup_v3_round_trips_book_category_file_state_coverless_metadata_and_annotations(client):
    register(client)
    headers = csrf_headers(client)
    category_response = client.post("/api/book-categories", headers=headers, json={"name": "技术"})
    assert category_response.status_code == 201, category_response.text
    category = category_response.json()
    original = "第一章\n这是需要备份的正文。".encode("utf-8")
    uploaded = client.post(
        "/api/books",
        headers=headers,
        data={"category_id": category["id"]},
        files={"file": ("阅读材料.txt", BytesIO(original), "text/plain")},
    )
    assert uploaded.status_code == 201, uploaded.text
    book = uploaded.json()
    state_body = {
        "locator": {"kind": "text", "start": 3, "end": 8, "quote": "这是需要"},
        "progress": 0.4,
        "font_size": 115,
        "font_family": "serif",
        "line_height": 1.8,
        "theme": "dark",
        "layout": "scrolled",
    }
    assert client.put(f"/api/books/{book['id']}/reading-state", headers=headers, json=state_body).status_code == 200
    annotation_body = {
        "type": "highlight",
        "locator": {"kind": "text", "start": 3, "end": 8, "quote": "这是需要"},
        "color": "yellow",
        "quote": "这是需要",
        "note": "备份批注",
    }
    assert client.post(f"/api/books/{book['id']}/annotations", headers=headers, json=annotation_body).status_code == 201

    exported = client.get("/api/data/export", params={"format": "backup"})
    assert exported.status_code == 200, exported.text
    with zipfile.ZipFile(BytesIO(exported.content)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["version"] == 3 and len(manifest["books"]) == 1
        assert [(item["id"], item["name"]) for item in manifest["book_categories"]] == [
            (category["id"], "技术")
        ]
        record = json.loads(archive.read(manifest["books"][0]["path"]))
        assert record["category_id"] == category["id"]
        assert archive.read(record["file"]["path"]) == original
        assert record["reading_state"]["progress"] == 0.4
        assert record["annotations"][0]["note"] == "备份批注"

    assert client.delete(f"/api/books/{book['id']}", headers=headers).status_code == 204
    assert client.delete(f"/api/book-categories/{category['id']}", headers=headers).status_code == 204
    imported = client.post(
        "/api/data/import",
        params={"format": "backup"},
        headers=headers,
        files={"file": ("backup-v3.zip", BytesIO(exported.content), "application/zip")},
    )
    assert imported.status_code == 200, imported.text
    assert imported.json()["books"] == 1
    assert imported.json()["annotations"] == 1
    restored = client.get("/api/books").json()
    assert len(restored) == 1 and restored[0]["title"] == "阅读材料"
    assert (restored[0]["category"]["id"], restored[0]["category"]["name"]) == (category["id"], "技术")
    assert client.get("/api/book-categories").json() == [category]
    assert client.get(restored[0]["download_url"]).content == original
    state = client.get(f"/api/books/{restored[0]['id']}/reading-state").json()
    assert state["progress"] == 0.4 and state["theme"] == "dark"
    annotations = client.get(f"/api/books/{restored[0]['id']}/annotations").json()
    assert annotations[0]["note"] == "备份批注"


def test_backup_v2_imports_books_as_uncategorized(client):
    register(client)
    headers = csrf_headers(client)
    original = "旧版备份".encode()
    uploaded = client.post(
        "/api/books",
        headers=headers,
        files={"file": ("旧版.txt", BytesIO(original), "text/plain")},
    )
    assert uploaded.status_code == 201, uploaded.text
    book = uploaded.json()
    _set_text_reading_state(client, headers, book["id"])
    exported = client.get("/api/data/export", params={"format": "backup"})
    assert exported.status_code == 200, exported.text

    def downgrade(manifest, entries):
        manifest["version"] = 2
        manifest.pop("book_categories")
        record_path = manifest["books"][0]["path"]
        record = json.loads(entries[record_path])
        record.pop("category_id")
        entries[record_path] = json.dumps(record).encode()
        manifest["books"][0]["sha256"] = hashlib.sha256(entries[record_path]).hexdigest()

    backup_v2 = _rewrite_backup(exported.content, downgrade)
    assert client.delete(f"/api/books/{book['id']}", headers=headers).status_code == 204
    imported = client.post(
        "/api/data/import",
        params={"format": "backup"},
        headers=headers,
        files={"file": ("backup-v2.zip", backup_v2, "application/zip")},
    )
    assert imported.status_code == 200, imported.text
    restored = client.get("/api/books").json()
    assert len(restored) == 1
    assert restored[0]["category"] is None
    assert client.get(restored[0]["download_url"]).content == original


@pytest.mark.parametrize(
    ("mutation", "expected_detail"),
    [
        ("duplicate_id", "backup contains duplicate book category IDs"),
        ("blank_name", "book category name cannot be blank"),
        ("unknown_reference", "book references an unknown category"),
    ],
)
def test_backup_v3_rejects_invalid_book_categories(client, mutation, expected_detail):
    register(client)
    headers = csrf_headers(client)
    category = client.post("/api/book-categories", headers=headers, json={"name": "技术"}).json()
    uploaded = client.post(
        "/api/books",
        headers=headers,
        data={"category_id": category["id"]},
        files={"file": ("分类.txt", BytesIO(b"category"), "text/plain")},
    )
    assert uploaded.status_code == 201, uploaded.text
    _set_text_reading_state(client, headers, uploaded.json()["id"])
    exported = client.get("/api/data/export", params={"format": "backup"})
    assert exported.status_code == 200, exported.text

    def corrupt(manifest, entries):
        if mutation == "duplicate_id":
            manifest["book_categories"].append(dict(manifest["book_categories"][0]))
        elif mutation == "blank_name":
            manifest["book_categories"][0]["name"] = "   "
        else:
            record_path = manifest["books"][0]["path"]
            record = json.loads(entries[record_path])
            record["category_id"] = "11111111-1111-4111-8111-111111111111"
            entries[record_path] = json.dumps(record).encode()
            manifest["books"][0]["sha256"] = hashlib.sha256(entries[record_path]).hexdigest()

    response = client.post(
        "/api/data/import",
        params={"format": "backup"},
        headers=headers,
        files={"file": ("invalid-v3.zip", _rewrite_backup(exported.content, corrupt), "application/zip")},
    )
    assert response.status_code == 422
    assert expected_detail in response.json()["detail"]


def test_backup_import_rejects_unsafe_paths(client):
    register(client)
    archive = _zip(
        {
            "manifest.json": json.dumps(
                {
                    "format": "note-backup",
                    "version": 1,
                    "exported_at": "2026-08-14T00:00:00Z",
                    "groups": [],
                    "tags": [],
                    "notes": [],
                }
            ).encode(),
            "../outside.txt": b"escape",
        }
    )
    response = client.post(
        "/api/data/import",
        params={"format": "backup"},
        headers=csrf_headers(client),
        files={"file": ("unsafe.zip", archive, "application/zip")},
    )
    assert response.status_code == 422
    assert "unsafe" in response.json()["detail"]


def test_backup_import_rejects_note_checksum_mismatch(client):
    register(client)
    note_id = "11111111-1111-4111-8111-111111111111"
    note_path = f"notes/{note_id}.json"
    note = json.dumps(
        {
            "id": note_id,
            "title": "bad hash",
            "content": {"type": "doc", "content": []},
            "search_text": "bad hash",
            "is_pinned": False,
            "deleted_at": None,
            "created_at": "2026-08-14T00:00:00Z",
            "updated_at": "2026-08-14T00:00:00Z",
            "group_id": None,
            "tag_ids": [],
            "attachments": [],
        }
    ).encode()
    manifest = json.dumps(
        {
            "format": "note-backup",
            "version": 1,
            "exported_at": "2026-08-14T00:00:00Z",
            "groups": [],
            "tags": [],
            "notes": [{"id": note_id, "path": note_path, "sha256": hashlib.sha256(b"different").hexdigest()}],
        }
    ).encode()
    response = client.post(
        "/api/data/import",
        params={"format": "backup"},
        headers=csrf_headers(client),
        files={"file": ("bad.zip", _zip({"manifest.json": manifest, note_path: note}), "application/zip")},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == f"note checksum mismatch: {note_id}"
    assert client.get("/api/notes").json() == []
