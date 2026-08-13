from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlparse

from fastapi import HTTPException


ALLOWED_NODES = {"doc", "paragraph", "text", "heading", "bulletList", "orderedList", "listItem", "blockquote", "codeBlock", "hardBreak", "image"}
ALLOWED_MARKS = {"bold", "italic", "strike", "code", "link"}
MAX_CONTENT_BYTES = 2 * 1024 * 1024


def extract_text(document: dict[str, Any]) -> str:
    texts: list[str] = []

    def collect(node: Any) -> None:
        if not isinstance(node, dict):
            return
        if node.get("type") == "text" and isinstance(node.get("text"), str):
            texts.append(node["text"])
        for child in node.get("content", []):
            collect(child)

    collect(document)
    return " ".join(texts)


def validate_content(document: dict[str, Any]) -> tuple[str, str]:
    encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_CONTENT_BYTES:
        raise HTTPException(413, "note content exceeds 2 MB")
    texts: list[str] = []

    def walk(node: Any) -> None:
        if not isinstance(node, dict) or node.get("type") not in ALLOWED_NODES:
            raise HTTPException(422, "unsupported rich-text node")
        if node["type"] == "doc" and node is not document:
            raise HTTPException(422, "nested document is not allowed")
        if node["type"] == "text":
            if not isinstance(node.get("text"), str):
                raise HTTPException(422, "text nodes require text")
            texts.append(node["text"])
        marks = node.get("marks", [])
        if not isinstance(marks, list):
            raise HTTPException(422, "marks must be a list")
        for mark in marks:
            if not isinstance(mark, dict) or mark.get("type") not in ALLOWED_MARKS:
                raise HTTPException(422, "unsupported rich-text mark")
            if mark["type"] == "link":
                href = (mark.get("attrs") or {}).get("href", "")
                parsed = urlparse(href)
                if parsed.scheme not in {"http", "https", "mailto"}:
                    raise HTTPException(422, "unsupported link protocol")
        if node["type"] == "image":
            src = (node.get("attrs") or {}).get("src", "")
            if not isinstance(src, str) or not src.startswith("/api/attachments/"):
                raise HTTPException(422, "images must reference an uploaded attachment")
        children = node.get("content", [])
        if not isinstance(children, list):
            raise HTTPException(422, "node content must be a list")
        for child in children:
            walk(child)

    if document.get("type") != "doc":
        raise HTTPException(422, "content root must be a document")
    walk(document)
    return encoded, " ".join(texts)
