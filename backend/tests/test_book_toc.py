from __future__ import annotations

from io import BytesIO

from pypdf import PdfWriter

from app.book_toc import infer_toc, normalize_text, read_pdf_outline
from app.database import get_db
from app.main import app
from app.models import BookOcrJob

from .conftest import csrf_headers, register


def _outlined_pdf() -> bytes:
    output = BytesIO()
    writer = PdfWriter()
    for _ in range(3):
        writer.add_blank_page(width=100, height=100)
    chapter = writer.add_outline_item("第一章 入门", 0)
    writer.add_outline_item("1.1 安装", 1, parent=chapter)
    writer.add_outline_item("第二章 进阶", 2)
    writer.write(output)
    return output.getvalue()


def _upload_pdf(client, headers) -> dict:
    response = client.post(
        "/api/books",
        headers=headers,
        files={"file": ("outlined.pdf", BytesIO(_outlined_pdf()), "application/pdf")},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _set_ocr_status(book_id: str, status: str) -> None:
    override = app.dependency_overrides[get_db]
    dependency = override()
    db = next(dependency)
    try:
        job = db.get(BookOcrJob, book_id)
        assert job is not None
        job.status = status
        db.commit()
    finally:
        dependency.close()


def test_normalize_text_handles_full_width_and_spaced_digits():
    assert normalize_text("第 １ 章\u3000简介\n１ ． ２ 标题  １ ２") == "第 1 章 简介\n1.2 标题 12"


def test_infer_toc_corrects_printed_page_offset_from_body_titles():
    pages = [
        (0, "封面"),
        (1, "目 录\n第一章 入门 …… 1\n1 . 1 安装 …… 3\n第二章 进阶 …… 5"),
        (2, "前言"),
        (3, "第一章 入门\n正文"),
        (4, "正文"),
        (5, "1.1 安装\n正文"),
        (6, "正文"),
        (7, "第二章 进阶\n正文"),
    ]

    items = infer_toc(pages, page_count=8)

    assert [(item["label"], item["level"], item["page_index"]) for item in items] == [
        ("第一章 入门", 1, 3),
        ("1.1 安装", 2, 5),
        ("第二章 进阶", 1, 7),
    ]


def test_infer_toc_falls_back_to_conservative_page_headings():
    items = infer_toc(
        [
            (0, "封面"),
            (1, "第一章 开始\n正文"),
            (2, "普通正文\n第二章 只是正文中提及"),
            (3, "1.1 安装方法\n正文"),
        ],
        page_count=4,
    )

    assert [(item["label"], item["level"], item["page_index"]) for item in items] == [
        ("第一章 开始", 1, 1),
        ("1.1 安装方法", 2, 3),
    ]


def test_infer_toc_recognizes_and_supplements_compact_third_level_headings():
    items = infer_toc(
        [
            (0, "封面"),
            (1, "目录\n第一章 入门 …… 1\n1.1 基础 …… 2"),
            (2, "前言"),
            (3, "第一章 入门\n正文"),
            (4, "第一章 入门\n1.1 基础\n1.1.1无需空格的三级标题\n正文"),
            (5, "第一章 入门\n1.1.2 带空格的三级标题\n正文"),
        ],
        page_count=6,
    )

    assert [(item["label"], item["level"], item["page_index"]) for item in items] == [
        ("第一章 入门", 1, 3),
        ("1.1 基础", 2, 4),
        ("1.1.1无需空格的三级标题", 3, 4),
        ("1.1.2 带空格的三级标题", 3, 5),
    ]


def test_read_pdf_outline_preserves_hierarchy(tmp_path):
    path = tmp_path / "outlined.pdf"
    path.write_bytes(_outlined_pdf())

    items = read_pdf_outline(path)

    assert [(item["label"], item["level"], item["page_index"]) for item in items] == [
        ("第一章 入门", 1, 0),
        ("1.1 安装", 2, 1),
        ("第二章 进阶", 1, 2),
    ]


def test_pdf_toc_route_uses_original_outline_permissions_and_ocr_state(client):
    register(client, "alice")
    headers = csrf_headers(client)
    book = _upload_pdf(client, headers)

    response = client.get(f"/api/books/{book['id']}/toc")
    assert response.status_code == 200, response.text
    assert response.json() == {
        "items": [
            {"id": "embedded-1", "label": "第一章 入门", "level": 1, "page_index": 0},
            {"id": "embedded-2", "label": "1.1 安装", "level": 2, "page_index": 1},
            {"id": "embedded-3", "label": "第二章 进阶", "level": 1, "page_index": 2},
        ],
        "source": "embedded",
        "index_complete": False,
    }

    _set_ocr_status(book["id"], "completed")
    assert client.get(f"/api/books/{book['id']}/toc").json()["index_complete"] is True

    assert client.post("/api/auth/logout", headers=headers).status_code == 204
    register(client, "bob")
    assert client.get(f"/api/books/{book['id']}/toc").status_code == 404


def test_toc_route_rejects_non_pdf_books(client):
    register(client)
    headers = csrf_headers(client)
    response = client.post(
        "/api/books",
        headers=headers,
        files={"file": ("story.txt", BytesIO(b"chapter"), "text/plain")},
    )
    assert response.status_code == 201, response.text

    toc = client.get(f"/api/books/{response.json()['id']}/toc")
    assert toc.status_code == 409
