from __future__ import annotations

import base64
from io import BytesIO
import zipfile

from pypdf import PdfReader, PdfWriter

from app.config import get_settings
from app.schemas import ReadingStateOut

from .conftest import csrf_headers, register


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def test_empty_reading_state_response_uses_null_timestamps():
    state = ReadingStateOut(book_id="book-without-state")

    assert state.last_read_at is None
    assert state.updated_at is None


def _upload_text(
    client,
    headers,
    *,
    name: str = "story.txt",
    body: bytes = "第一章\nhello world".encode(),
    data: dict[str, str] | None = None,
):
    return client.post(
        "/api/books",
        headers=headers,
        data=data,
        files={"file": (name, BytesIO(body), "application/octet-stream")},
    )


def _pdf_bytes(*, scripted: bool = False) -> bytes:
    output = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.add_metadata({"/Title": "Sample PDF", "/Author": "Tester"})
    if scripted:
        writer.add_js("app.alert('unsafe')")
    writer.write(output)
    return output.getvalue()


def _epub_bytes(*, encrypted: bool = False) -> bytes:
    output = BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        archive.writestr(
            "META-INF/container.xml",
            '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        )
        if encrypted:
            archive.writestr("META-INF/encryption.xml", "<encryption/>")
        archive.writestr(
            "OEBPS/content.opf",
            '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>EPUB 标题</dc:title><dc:creator>EPUB 作者</dc:creator></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
        )
        archive.writestr(
            "OEBPS/chapter.xhtml",
            '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body onload="alert(1)"><script>alert(1)</script><p>safe chapter text</p></body></html>',
        )
    return output.getvalue()


def test_text_book_lifecycle_state_annotations_search_and_cover(client):
    register(client)
    headers = csrf_headers(client)
    assert _upload_text(client, {}).status_code == 403
    uploaded = _upload_text(client, headers)
    assert uploaded.status_code == 201, uploaded.text
    book = uploaded.json()
    assert book["title"] == "story"
    assert book["format"] == "txt"
    assert book["ocr_status"] is None
    assert book["progress"] == 0
    assert book["ocr_error"] is None

    listed = client.get("/api/books", params={"q": "STORY", "format": "txt", "sort": "title"})
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()] == [book["id"]]
    assert "ocr_error" not in listed.json()[0]

    content = client.get(book["content_url"])
    assert content.status_code == 200
    assert content.content.decode() == "第一章\nhello world"
    partial = client.get(book["content_url"], headers={"Range": "bytes=0-2"})
    assert partial.status_code == 206
    assert partial.content == "第".encode()
    download = client.get(book["download_url"])
    assert download.content == "第一章\nhello world".encode()
    assert download.headers["content-disposition"].startswith("attachment;")

    updated = client.patch(
        f"/api/books/{book['id']}", headers=headers, json={"title": "  新书名  ", "author": "  作者  "}
    )
    assert updated.status_code == 200
    assert updated.json()["title"] == "新书名"
    assert updated.json()["author"] == "作者"

    initial_state = client.get(f"/api/books/{book['id']}/reading-state")
    assert initial_state.json()["locator"] is None
    state = client.put(
        f"/api/books/{book['id']}/reading-state",
        headers=headers,
        json={
            "locator": {"kind": "text", "start": 3, "end": 8},
            "progress": 0.5,
            "font_size": 112,
            "font_family": "serif",
            "line_height": 1.8,
            "theme": "dark",
            "layout": "scrolled",
        },
    )
    assert state.status_code == 200, state.text
    assert state.json()["locator"] == {"kind": "text", "start": 3, "end": 8, "quote": None}
    assert state.json()["progress"] == 0.5
    assert client.get("/api/books").json()[0]["progress"] == 0.5

    annotation = client.post(
        f"/api/books/{book['id']}/annotations",
        headers=headers,
        json={
            "type": "highlight",
            "locator": {"kind": "text", "start": 4, "end": 9},
            "color": "yellow",
            "quote": "hello",
        },
    )
    assert annotation.status_code == 201, annotation.text
    annotation_id = annotation.json()["id"]
    patched = client.patch(
        f"/api/books/{book['id']}/annotations/{annotation_id}", headers=headers, json={"note": "important"}
    )
    assert patched.json()["note"] == "important"
    assert len(client.get(f"/api/books/{book['id']}/annotations").json()) == 1

    search = client.get(f"/api/books/{book['id']}/search", params={"q": "WORLD"})
    assert search.status_code == 200
    assert search.json()["index_complete"] is True
    assert search.json()["items"][0]["locator"]["kind"] == "text"
    assert "world" in search.json()["items"][0]["excerpt"]

    cover = client.post(
        f"/api/books/{book['id']}/cover",
        headers=headers,
        files={"file": ("cover.png", BytesIO(PNG_1X1), "image/png")},
    )
    assert cover.status_code == 200, cover.text
    assert client.get(cover.json()["cover_url"]).content == PNG_1X1
    assert client.delete(f"/api/books/{book['id']}/cover", headers=headers).json()["cover_url"] is None

    assert client.delete(
        f"/api/books/{book['id']}/annotations/{annotation_id}", headers=headers
    ).status_code == 204
    stored = list(get_settings().book_path().iterdir())
    assert len(stored) == 2
    assert client.delete(f"/api/books/{book['id']}", headers=headers).status_code == 204
    assert not any(path.exists() for path in stored)
    assert client.get(f"/api/books/{book['id']}").status_code == 404


def test_pdf_validation_ocr_state_and_retry(client):
    register(client)
    headers = csrf_headers(client)
    invalid = client.post(
        "/api/books",
        headers=headers,
        files={"file": ("broken.pdf", BytesIO(b"not pdf"), "application/pdf")},
    )
    assert invalid.status_code == 422
    assert list(get_settings().book_path().iterdir()) == []

    uploaded = client.post(
        "/api/books",
        headers=headers,
        files={"file": ("sample.pdf", BytesIO(_pdf_bytes(scripted=True)), "application/pdf")},
    )
    assert uploaded.status_code == 201, uploaded.text
    book = uploaded.json()
    assert book["title"] == "Sample PDF"
    assert book["author"] == "Tester"
    assert book["page_count"] == 1
    assert book["ocr_status"] == "queued"
    assert book["ocr_progress"] == 0
    safe_reader = PdfReader(BytesIO(client.get(book["content_url"]).content))
    safe_root = safe_reader.trailer["/Root"]
    assert "/OpenAction" not in safe_root
    safe_names = safe_root.get("/Names")
    assert safe_names is None or "/JavaScript" not in safe_names.get_object()
    assert client.post(f"/api/books/{book['id']}/ocr/retry", headers=headers).status_code == 409


def test_book_user_isolation_and_upload_limits(client):
    register(client, "alice")
    alice_headers = csrf_headers(client)
    book = _upload_text(client, alice_headers).json()
    client.post("/api/auth/logout", headers=alice_headers)
    register(client, "bob")
    bob_headers = csrf_headers(client)
    assert client.get(f"/api/books/{book['id']}").status_code == 404
    assert client.get(f"/api/books/{book['id']}/content").status_code == 404
    assert client.patch(f"/api/books/{book['id']}", headers=bob_headers, json={"title": "stolen"}).status_code == 404

    settings = get_settings()
    previous = settings.storage.max_book_bytes
    settings.storage.max_book_bytes = 3
    try:
        too_large = _upload_text(client, bob_headers, name="large.md", body=b"1234")
        assert too_large.status_code == 413
        assert not any(path.name.endswith(".part") for path in settings.book_path().iterdir())
    finally:
        settings.storage.max_book_bytes = previous


def test_book_categories_crud_filtering_assignment_and_isolation(client):
    register(client, "alice")
    headers = csrf_headers(client)

    assert client.get("/api/book-categories").json() == []
    assert client.post("/api/book-categories", json={"name": "Fiction"}).status_code == 403
    fiction_response = client.post(
        "/api/book-categories", headers=headers, json={"name": "  Fiction  "}
    )
    assert fiction_response.status_code == 201, fiction_response.text
    fiction = fiction_response.json()
    assert fiction["name"] == "Fiction"
    assert fiction["created_at"].endswith("Z")
    duplicate = client.post(
        "/api/book-categories", headers=headers, json={"name": "fIcTiOn"}
    )
    assert duplicate.status_code == 409

    reference = client.post(
        "/api/book-categories", headers=headers, json={"name": "Reference"}
    ).json()
    assert [item["name"] for item in client.get("/api/book-categories").json()] == [
        "Fiction",
        "Reference",
    ]

    categorized = _upload_text(
        client,
        headers,
        name="novel.txt",
        data={"category_id": fiction["id"]},
    )
    assert categorized.status_code == 201, categorized.text
    categorized_book = categorized.json()
    assert categorized_book["category"]["id"] == fiction["id"]
    uncategorized_book = _upload_text(client, headers, name="loose.md").json()

    fiction_books = client.get("/api/books", params={"category_id": fiction["id"]})
    assert fiction_books.status_code == 200
    assert [item["id"] for item in fiction_books.json()] == [categorized_book["id"]]
    loose_books = client.get("/api/books", params={"uncategorized": "true"})
    assert [item["id"] for item in loose_books.json()] == [uncategorized_book["id"]]
    mutually_exclusive = client.get(
        "/api/books",
        params={"category_id": fiction["id"], "uncategorized": "true"},
    )
    assert mutually_exclusive.status_code == 422

    moved = client.patch(
        f"/api/books/{categorized_book['id']}",
        headers=headers,
        json={"category_id": reference["id"]},
    )
    assert moved.status_code == 200
    assert moved.json()["category"]["id"] == reference["id"]
    removed = client.patch(
        f"/api/books/{categorized_book['id']}", headers=headers, json={"category_id": None}
    )
    assert removed.status_code == 200
    assert removed.json()["category"] is None
    assert client.patch(
        f"/api/books/{categorized_book['id']}",
        headers=headers,
        json={"category_id": "00000000-0000-0000-0000-000000000000"},
    ).status_code == 404

    renamed = client.patch(
        f"/api/book-categories/{reference['id']}",
        headers=headers,
        json={"name": "Archive"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Archive"
    assigned = client.patch(
        f"/api/books/{categorized_book['id']}",
        headers=headers,
        json={"category_id": fiction["id"]},
    )
    assert assigned.status_code == 200
    assert client.delete(f"/api/book-categories/{fiction['id']}", headers=headers).status_code == 204
    assert client.get(f"/api/books/{categorized_book['id']}").json()["category"] is None

    assert client.post("/api/auth/logout", headers=headers).status_code == 204
    register(client, "bob")
    bob_headers = csrf_headers(client)
    bob_fiction = client.post(
        "/api/book-categories", headers=bob_headers, json={"name": "Fiction"}
    )
    assert bob_fiction.status_code == 201
    assert [item["id"] for item in client.get("/api/book-categories").json()] == [
        bob_fiction.json()["id"]
    ]
    assert client.patch(
        f"/api/book-categories/{reference['id']}",
        headers=bob_headers,
        json={"name": "Stolen"},
    ).status_code == 404
    assert _upload_text(
        client,
        bob_headers,
        name="foreign.txt",
        data={"category_id": reference["id"]},
    ).status_code == 404


def test_epub_metadata_safe_reader_and_markdown_extensions(client):
    register(client)
    headers = csrf_headers(client)
    uploaded = client.post(
        "/api/books",
        headers=headers,
        files={"file": ("novel.epub", BytesIO(_epub_bytes()), "application/zip")},
    )
    assert uploaded.status_code == 201, uploaded.text
    book = uploaded.json()
    assert book["title"] == "EPUB 标题"
    assert book["author"] == "EPUB 作者"
    reader_bytes = client.get(book["content_url"]).content
    with zipfile.ZipFile(BytesIO(reader_bytes)) as archive:
        chapter = archive.read("OEBPS/chapter.xhtml").decode()
        assert "safe chapter text" in chapter
        assert "<script" not in chapter
        assert "onload" not in chapter
    results = client.get(f"/api/books/{book['id']}/search", params={"q": "chapter"}).json()
    assert results["items"][0]["locator"] == {
        "kind": "epub",
        "cfi": "",
        "href": "OEBPS/chapter.xhtml",
        "end_cfi": None,
    }

    rejected = client.post(
        "/api/books",
        headers=headers,
        files={"file": ("locked.epub", BytesIO(_epub_bytes(encrypted=True)), "application/epub+zip")},
    )
    assert rejected.status_code == 422

    for extension in ("md", "markdown"):
        response = _upload_text(client, headers, name=f"readme.{extension}", body=b"# Heading\nbody")
        assert response.status_code == 201, response.text
        assert response.json()["format"] == extension
