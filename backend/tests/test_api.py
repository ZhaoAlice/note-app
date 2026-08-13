from io import BytesIO
import copy
import base64

from app.config import get_settings

from .conftest import csrf_headers, register


DOC = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "你好 world"}]}]}
PNG_1X1 = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")


def test_auth_csrf_and_note_lifecycle(client):
    user = register(client)
    assert client.get("/api/auth/me").json()["id"] == user["id"]
    assert client.post("/api/notes", json={"title": "blocked"}).status_code == 403
    headers = csrf_headers(client)
    assert client.patch("/api/auth/me", json={"display_name": "blocked"}).status_code == 403
    profile = client.patch("/api/auth/me", headers=headers, json={"display_name": "  记录者  "})
    assert profile.status_code == 200
    assert profile.json()["display_name"] == "记录者"
    assert client.get("/api/auth/me").json()["display_name"] == "记录者"
    created = client.post("/api/notes", headers=headers, json={"title": "First", "content": DOC, "tag_names": ["Work"], "is_pinned": True})
    assert created.status_code == 201, created.text
    note = created.json()
    assert note["created_at"].endswith("Z")
    assert note["updated_at"].endswith("Z")
    assert note["content"] == DOC
    assert note["tags"][0]["name"] == "Work"
    listed = client.get("/api/notes", params={"q": "你好"}).json()
    assert [item["id"] for item in listed] == [note["id"]]
    assert listed[0]["excerpt"]
    updated = client.patch(f"/api/notes/{note['id']}", headers=headers, json={"title": "Renamed", "tag_names": ["work"]})
    assert updated.status_code == 200
    assert updated.json()["title"] == "Renamed"
    assert [tag["name"] for tag in client.get("/api/tags").json()] == ["Work"]
    without_tags = client.patch(f"/api/notes/{note['id']}", headers=headers, json={"tag_names": []})
    assert without_tags.status_code == 200
    assert client.get("/api/tags").json() == []
    assert client.delete(f"/api/notes/{note['id']}", headers=headers).status_code == 204
    assert len(client.get("/api/notes", params={"status": "trash"}).json()) == 1
    assert client.post(f"/api/notes/{note['id']}/restore", headers=headers).status_code == 200


def test_attachment_upload_download_delete(client):
    register(client)
    headers = csrf_headers(client)
    note = client.post("/api/notes", headers=headers, json={"title": "Files"}).json()
    upload = client.post(
        f"/api/notes/{note['id']}/attachments",
        headers=headers,
        files={"file": ("readme.txt", BytesIO(b"hello"), "text/plain")},
    )
    assert upload.status_code == 201, upload.text
    attachment = upload.json()
    stored_files = list(get_settings().attachment_path().iterdir())
    assert len(stored_files) == 1
    assert stored_files[0].read_bytes() == b"hello"
    content = client.get(attachment["content_url"])
    assert content.content == b"hello"
    assert content.headers["x-content-type-options"] == "nosniff"
    assert client.delete(f"/api/attachments/{attachment['id']}", headers=headers).status_code == 204
    assert not stored_files[0].exists()
    assert client.get(attachment["content_url"]).status_code == 404


def test_attachment_types_follow_configuration(client):
    register(client)
    headers = csrf_headers(client)
    note = client.post("/api/notes", headers=headers, json={"title": "Configured files"}).json()
    settings = get_settings()
    previous = copy.deepcopy(settings.storage.allowed_types)
    settings.storage.allowed_types = {"image/png": [".png"]}
    try:
        rejected = client.post(
            f"/api/notes/{note['id']}/attachments",
            headers=headers,
            files={"file": ("readme.txt", BytesIO(b"hello"), "text/plain")},
        )
        assert rejected.status_code == 422
        accepted = client.post(
            f"/api/notes/{note['id']}/attachments",
            headers=headers,
            files={"file": ("pixel.png", BytesIO(PNG_1X1), "image/png")},
        )
        assert accepted.status_code == 201
        image = client.get(accepted.json()["content_url"])
        assert image.content == PNG_1X1
        assert image.headers["content-type"] == "image/png"
        assert image.headers["content-disposition"].startswith("inline;")

        invalid_image = client.post(
            f"/api/notes/{note['id']}/attachments",
            headers=headers,
            files={"file": ("broken.png", BytesIO(b"not an image"), "image/png")},
        )
        assert invalid_image.status_code == 422
    finally:
        settings.storage.allowed_types = previous


def test_user_isolation_and_origin_validation(client):
    register(client, "alice")
    first_headers = csrf_headers(client)
    group = client.post("/api/groups", headers=first_headers, json={"name": "Alice 私有分组"}).json()
    note = client.post("/api/notes", headers=first_headers, json={"title": "private"}).json()
    client.post("/api/auth/logout", headers=first_headers)
    register(client, "bob")
    assert client.get(f"/api/notes/{note['id']}").status_code == 404
    assert client.get("/api/groups").json() == []
    assert client.post("/api/notes", headers=csrf_headers(client), json={"title": "blocked", "group_id": group["id"]}).status_code == 404
    rejected = client.post(
        "/api/auth/login",
        headers={"Origin": "https://evil.example"},
        json={"username": "bob", "password": "password123"},
    )
    assert rejected.status_code == 403


def test_permanent_delete_requires_trash(client):
    register(client)
    headers = csrf_headers(client)
    note = client.post("/api/notes", headers=headers, json={"title": "Delete"}).json()
    assert client.delete(f"/api/notes/{note['id']}/permanent", headers=headers).status_code == 409
    client.delete(f"/api/notes/{note['id']}", headers=headers)
    assert client.delete(f"/api/notes/{note['id']}/permanent", headers=headers).status_code == 204
    assert client.get(f"/api/notes/{note['id']}").status_code == 404


def test_group_lifecycle_and_note_assignment(client):
    register(client)
    headers = csrf_headers(client)
    created_group = client.post("/api/groups", headers=headers, json={"name": " 工作 "})
    assert created_group.status_code == 201
    group = created_group.json()
    assert group["name"] == "工作"
    assert client.post("/api/groups", headers=headers, json={"name": "工作"}).status_code == 409

    note = client.post("/api/notes", headers=headers, json={"title": "项目", "group_id": group["id"]})
    assert note.status_code == 201
    assert note.json()["group"] == group
    grouped = client.get("/api/notes", params={"group_id": group["id"]}).json()
    assert [item["id"] for item in grouped] == [note.json()["id"]]
    assert client.get("/api/notes", params={"ungrouped": "true"}).json() == []

    renamed = client.patch(f"/api/groups/{group['id']}", headers=headers, json={"name": "项目资料"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "项目资料"
    assert client.delete(f"/api/groups/{group['id']}", headers=headers).status_code == 204
    assert client.get(f"/api/notes/{note.json()['id']}").json()["group"] is None
    assert [item["id"] for item in client.get("/api/notes", params={"ungrouped": "true"}).json()] == [note.json()["id"]]
