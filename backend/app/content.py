from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlparse

from fastapi import HTTPException


ALLOWED_NODES = {
    "doc",
    "paragraph",
    "text",
    "heading",
    "bulletList",
    "orderedList",
    "listItem",
    "taskList",
    "taskItem",
    "blockquote",
    "codeBlock",
    "hardBreak",
    "horizontalRule",
    "image",
    "table",
    "tableRow",
    "tableHeader",
    "tableCell",
}
ALLOWED_MARKS = {"bold", "italic", "strike", "underline", "highlight", "code", "link"}
TEXT_ALIGNMENTS = {"left", "center", "right", "justify"}
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

    def validate_node_attributes(node: dict[str, Any]) -> None:
        node_type = node["type"]
        attrs = node.get("attrs", {})
        if attrs is None:
            attrs = {}
        if not isinstance(attrs, dict):
            raise HTTPException(422, "node attrs must be an object")

        if node_type == "heading" and attrs.get("level") not in {1, 2, 3}:
            raise HTTPException(422, "heading level must be between 1 and 3")
        if node_type in {"heading", "paragraph"}:
            text_align = attrs.get("textAlign")
            if text_align is not None and text_align not in TEXT_ALIGNMENTS:
                raise HTTPException(422, "unsupported text alignment")
        if node_type == "taskItem" and not isinstance(attrs.get("checked"), bool):
            raise HTTPException(422, "task items require a boolean checked state")
        if node_type in {"tableCell", "tableHeader"}:
            colspan = attrs.get("colspan", 1)
            rowspan = attrs.get("rowspan", 1)
            colwidth = attrs.get("colwidth")
            if isinstance(colspan, bool) or not isinstance(colspan, int) or not 1 <= colspan <= 100:
                raise HTTPException(422, "invalid table cell colspan")
            if isinstance(rowspan, bool) or not isinstance(rowspan, int) or not 1 <= rowspan <= 100:
                raise HTTPException(422, "invalid table cell rowspan")
            if colwidth is not None and (
                not isinstance(colwidth, list)
                or len(colwidth) != colspan
                or any(isinstance(width, bool) or not isinstance(width, int) or width <= 0 for width in colwidth)
            ):
                raise HTTPException(422, "invalid table cell widths")

    def validate_children(node: dict[str, Any], children: list[Any]) -> None:
        child_types = [child.get("type") if isinstance(child, dict) else None for child in children]
        node_type = node["type"]
        if node_type == "taskList" and (not children or any(child_type != "taskItem" for child_type in child_types)):
            raise HTTPException(422, "task lists may only contain task items")
        if node_type == "taskItem" and (not children or child_types[0] != "paragraph"):
            raise HTTPException(422, "task items must begin with a paragraph")
        if node_type == "table" and (not children or any(child_type != "tableRow" for child_type in child_types)):
            raise HTTPException(422, "tables may only contain rows")
        if node_type == "tableRow" and (
            not children or any(child_type not in {"tableCell", "tableHeader"} for child_type in child_types)
        ):
            raise HTTPException(422, "table rows may only contain cells")
        if node_type in {"tableCell", "tableHeader"} and not children:
            raise HTTPException(422, "table cells cannot be empty")
        if node_type in {"text", "hardBreak", "horizontalRule", "image"} and children:
            raise HTTPException(422, f"{node_type} nodes cannot contain child nodes")

    def walk(node: Any) -> None:
        if not isinstance(node, dict) or node.get("type") not in ALLOWED_NODES:
            raise HTTPException(422, "unsupported rich-text node")
        if node["type"] == "doc" and node is not document:
            raise HTTPException(422, "nested document is not allowed")
        validate_node_attributes(node)
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
        validate_children(node, children)
        for child in children:
            walk(child)

    if not isinstance(document, dict) or document.get("type") != "doc":
        raise HTTPException(422, "content root must be a document")
    walk(document)
    return encoded, " ".join(texts)
