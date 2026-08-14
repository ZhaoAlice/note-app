from __future__ import annotations

import base64
import hashlib
import json
import zipfile
from io import BytesIO

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
        assert manifest["version"] == 1
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
    assert imported.json() == {"notes": 1, "attachments": 1, "renamed": 1, "warnings": []}
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
