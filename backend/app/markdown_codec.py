from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, Mapping, Sequence
from urllib.parse import unquote, urlparse


ATTACHMENT_URL_RE = re.compile(r"^/api/attachments/([^/]+)/content$")
LIST_ITEM_RE = re.compile(r"^(\s*)([-+*]|\d+[.)])\s+(.*)$")
IMAGE_RE = re.compile(r'^!\[([^]]*)\]\((\S+?)(?:\s+["\'](.*?)["\'])?\)$')


@dataclass(frozen=True)
class MarkdownExportResult:
    markdown: str
    warnings: tuple[str, ...]


@dataclass(frozen=True)
class MarkdownImageReference:
    placeholder: str
    source_path: str
    alt: str
    title: str | None = None


@dataclass(frozen=True)
class MarkdownImportResult:
    document: dict[str, Any]
    image_references: tuple[MarkdownImageReference, ...]
    warnings: tuple[str, ...]


class _Warnings:
    def __init__(self) -> None:
        self._items: list[str] = []

    def add(self, message: str) -> None:
        if message not in self._items:
            self._items.append(message)

    def result(self) -> tuple[str, ...]:
        return tuple(self._items)


def tiptap_to_markdown(
    document: Mapping[str, Any], attachment_paths: Mapping[str, str] | None = None
) -> MarkdownExportResult:
    """Convert a Tiptap JSON document into portable Markdown.

    ``attachment_paths`` maps attachment IDs from Tiptap image URLs to paths
    inside the eventual export archive. Unsupported formatting is retained as
    plain text and reported through ``warnings``.
    """

    warnings = _Warnings()
    paths = attachment_paths or {}
    blocks = [_render_block(node, paths, warnings) for node in document.get("content", [])]
    markdown = "\n\n".join(block for block in blocks if block != "").rstrip()
    if markdown:
        markdown += "\n"
    return MarkdownExportResult(markdown=markdown, warnings=warnings.result())


def markdown_to_tiptap(markdown: str) -> MarkdownImportResult:
    """Parse supported Markdown into Tiptap JSON plus local image references.

    Relative images receive deterministic ``markdown-import://image/N``
    placeholders. The import service must upload each referenced file, replace
    the placeholder with its attachment URL, and then validate the document.
    Remote images are deliberately converted to ordinary links.
    """

    warnings = _Warnings()
    images: list[MarkdownImageReference] = []
    normalized = markdown.replace("\r\n", "\n").replace("\r", "\n")
    content, _ = _parse_blocks(normalized.split("\n"), 0, warnings, images)
    return MarkdownImportResult(
        document={"type": "doc", "content": content},
        image_references=tuple(images),
        warnings=warnings.result(),
    )


def _render_block(node: Mapping[str, Any], paths: Mapping[str, str], warnings: _Warnings) -> str:
    node_type = node.get("type")
    if node_type == "paragraph":
        _warn_alignment(node, warnings)
        return _render_inline(node.get("content", []), paths, warnings)
    if node_type == "heading":
        _warn_alignment(node, warnings)
        level = max(1, min(3, int((node.get("attrs") or {}).get("level", 1))))
        return f"{'#' * level} {_render_inline(node.get('content', []), paths, warnings)}"
    if node_type == "blockquote":
        inner = "\n\n".join(_render_block(child, paths, warnings) for child in node.get("content", []))
        return "\n".join(f"> {line}" if line else ">" for line in inner.splitlines())
    if node_type == "codeBlock":
        language = str((node.get("attrs") or {}).get("language") or "")
        code = "".join(str(child.get("text", "")) for child in node.get("content", []))
        fence = "```" if "```" not in code else "````"
        return f"{fence}{language}\n{code}\n{fence}"
    if node_type == "horizontalRule":
        return "---"
    if node_type in {"bulletList", "orderedList", "taskList"}:
        return _render_list(node, paths, warnings)
    if node_type == "table":
        return _render_table(node, paths, warnings)
    if node_type == "image":
        return _render_image(node, paths, warnings)
    warnings.add(f"unsupported Tiptap node '{node_type}' was omitted")
    return ""


def _render_inline(nodes: Sequence[Mapping[str, Any]], paths: Mapping[str, str], warnings: _Warnings) -> str:
    rendered: list[str] = []
    for node in nodes:
        node_type = node.get("type")
        if node_type == "hardBreak":
            rendered.append("  \n")
            continue
        if node_type == "image":
            rendered.append(_render_image(node, paths, warnings))
            continue
        if node_type != "text":
            rendered.append(_render_block(node, paths, warnings))
            continue
        text = _escape_text(str(node.get("text", "")))
        marks = list(node.get("marks", []))
        code_mark = next((mark for mark in marks if mark.get("type") == "code"), None)
        if code_mark:
            raw = str(node.get("text", ""))
            delimiter = "``" if "`" in raw else "`"
            text = f"{delimiter}{raw}{delimiter}"
        for mark in marks:
            mark_type = mark.get("type")
            if mark_type == "bold":
                text = f"**{text}**"
            elif mark_type == "italic":
                text = f"*{text}*"
            elif mark_type == "strike":
                text = f"~~{text}~~"
            elif mark_type == "link":
                attrs = mark.get("attrs") or {}
                href = str(attrs.get("href", ""))
                title = attrs.get("title")
                suffix = f' "{title}"' if title else ""
                text = f"[{text}]({href}{suffix})"
            elif mark_type == "underline":
                warnings.add("underline formatting is not supported by Markdown and was removed")
            elif mark_type == "highlight":
                warnings.add("highlight formatting is not supported by Markdown and was removed")
        rendered.append(text)
    return "".join(rendered)


def _render_list(node: Mapping[str, Any], paths: Mapping[str, str], warnings: _Warnings) -> str:
    node_type = node.get("type")
    start = int((node.get("attrs") or {}).get("start", 1))
    lines: list[str] = []
    for index, item in enumerate(node.get("content", [])):
        if node_type == "orderedList":
            prefix = f"{start + index}. "
        elif node_type == "taskList":
            checked = bool((item.get("attrs") or {}).get("checked"))
            prefix = f"- [{'x' if checked else ' '}] "
        else:
            prefix = "- "
        children = [_render_block(child, paths, warnings) for child in item.get("content", [])]
        body = "\n\n".join(child for child in children if child != "")
        body_lines = body.splitlines() or [""]
        lines.append(prefix + body_lines[0])
        lines.extend("  " + line for line in body_lines[1:])
    return "\n".join(lines)


def _render_table(node: Mapping[str, Any], paths: Mapping[str, str], warnings: _Warnings) -> str:
    rows = list(node.get("content", []))
    if not rows:
        return ""
    rendered_rows: list[list[str]] = []
    first_is_header = all(cell.get("type") == "tableHeader" for cell in rows[0].get("content", []))
    for row in rows:
        cells: list[str] = []
        for cell in row.get("content", []):
            attrs = cell.get("attrs") or {}
            if attrs.get("colspan", 1) != 1 or attrs.get("rowspan", 1) != 1:
                warnings.add("complex table spans are not supported by Markdown and were flattened")
            value = "<br>".join(
                _render_block(child, paths, warnings).replace("\n", "<br>") for child in cell.get("content", [])
            )
            cells.append(value.replace("|", "\\|"))
        rendered_rows.append(cells)
    width = max(len(row) for row in rendered_rows)
    if not first_is_header:
        warnings.add("a header row was added because Markdown tables require one")
        rendered_rows.insert(0, [""] * width)
    rendered_rows = [row + [""] * (width - len(row)) for row in rendered_rows]
    lines = ["| " + " | ".join(row) + " |" for row in rendered_rows]
    lines.insert(1, "| " + " | ".join("---" for _ in range(width)) + " |")
    return "\n".join(lines)


def _render_image(node: Mapping[str, Any], paths: Mapping[str, str], warnings: _Warnings) -> str:
    attrs = node.get("attrs") or {}
    src = str(attrs.get("src", ""))
    match = ATTACHMENT_URL_RE.match(src)
    path = paths.get(match.group(1)) if match else None
    if path is None:
        warnings.add(f"image '{src}' has no exported attachment path and was kept as its original URL")
        path = src
    path = PurePosixPath(str(path).replace("\\", "/")).as_posix() if not urlparse(str(path)).scheme else str(path)
    path = path.replace(" ", "%20")
    alt = str(attrs.get("alt") or "").replace("]", "\\]")
    title = attrs.get("title")
    suffix = f' "{title}"' if title else ""
    return f"![{alt}]({path}{suffix})"


def _warn_alignment(node: Mapping[str, Any], warnings: _Warnings) -> None:
    alignment = (node.get("attrs") or {}).get("textAlign")
    if alignment not in {None, "left"}:
        warnings.add("text alignment is not supported by Markdown and was removed")


def _escape_text(text: str) -> str:
    return re.sub(r"([\\`*_[\]<>#])", r"\\\1", text)


def _parse_blocks(
    lines: Sequence[str], start: int, warnings: _Warnings, images: list[MarkdownImageReference]
) -> tuple[list[dict[str, Any]], int]:
    nodes: list[dict[str, Any]] = []
    index = start
    while index < len(lines):
        line = lines[index]
        if not line.strip():
            index += 1
            continue
        fence = re.match(r"^\s*(`{3,}|~{3,})([^`]*)$", line)
        if fence:
            marker, language = fence.group(1), fence.group(2).strip()
            index += 1
            body: list[str] = []
            while index < len(lines) and not re.match(rf"^\s*{re.escape(marker[0])}{{{len(marker)},}}\s*$", lines[index]):
                body.append(lines[index])
                index += 1
            if index < len(lines):
                index += 1
            attrs = {"language": language or None}
            nodes.append({"type": "codeBlock", "attrs": attrs, "content": [{"type": "text", "text": "\n".join(body)}]})
            continue
        heading = re.match(r"^(#{1,6})\s+(.*)$", line)
        if heading:
            level = min(3, len(heading.group(1)))
            if len(heading.group(1)) > 3:
                warnings.add("heading levels below H3 were converted to H3")
            nodes.append({"type": "heading", "attrs": {"level": level}, "content": _parse_inline(heading.group(2), warnings, images)})
            index += 1
            continue
        if re.match(r"^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$", line):
            nodes.append({"type": "horizontalRule"})
            index += 1
            continue
        if line.lstrip().startswith(">"):
            quoted: list[str] = []
            while index < len(lines) and lines[index].lstrip().startswith(">"):
                quoted.append(re.sub(r"^\s*>\s?", "", lines[index]))
                index += 1
            content, _ = _parse_blocks(quoted, 0, warnings, images)
            nodes.append({"type": "blockquote", "content": content})
            continue
        list_match = LIST_ITEM_RE.match(line)
        if list_match:
            list_node, index = _parse_list(lines, index, len(list_match.group(1)), warnings, images)
            nodes.append(list_node)
            continue
        if index + 1 < len(lines) and _is_table_separator(lines[index + 1]):
            table, index = _parse_table(lines, index, warnings, images)
            nodes.append(table)
            continue
        image_match = IMAGE_RE.match(line.strip())
        if image_match:
            nodes.append(_image_or_link(image_match.group(1), image_match.group(2), image_match.group(3), warnings, images, block=True))
            index += 1
            continue
        paragraph_lines = [line]
        index += 1
        while index < len(lines) and lines[index].strip() and not _starts_block(lines, index):
            paragraph_lines.append(lines[index])
            index += 1
        inline: list[dict[str, Any]] = []
        for line_index, paragraph_line in enumerate(paragraph_lines):
            hard_break = paragraph_line.endswith("  ") or paragraph_line.endswith("\\")
            text = paragraph_line[:-2] if paragraph_line.endswith("  ") else paragraph_line[:-1] if paragraph_line.endswith("\\") else paragraph_line
            inline.extend(_parse_inline(text, warnings, images))
            if line_index < len(paragraph_lines) - 1:
                inline.append({"type": "hardBreak"} if hard_break else {"type": "text", "text": " "})
        nodes.append({"type": "paragraph", "content": inline})
    return nodes, index


def _starts_block(lines: Sequence[str], index: int) -> bool:
    line = lines[index]
    return bool(
        re.match(r"^\s*(`{3,}|~{3,})", line)
        or re.match(r"^#{1,6}\s+", line)
        or re.match(r"^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$", line)
        or line.lstrip().startswith(">")
        or LIST_ITEM_RE.match(line)
        or (index + 1 < len(lines) and _is_table_separator(lines[index + 1]))
        or IMAGE_RE.match(line.strip())
    )


def _parse_list(
    lines: Sequence[str], start: int, indent: int, warnings: _Warnings, images: list[MarkdownImageReference]
) -> tuple[dict[str, Any], int]:
    first = LIST_ITEM_RE.match(lines[start])
    assert first is not None
    ordered = first.group(2)[0].isdigit()
    task = not ordered and bool(re.match(r"^\[[ xX]\]\s+", first.group(3)))
    node_type = "orderedList" if ordered else "taskList" if task else "bulletList"
    items: list[dict[str, Any]] = []
    index = start
    start_number = int(re.match(r"\d+", first.group(2)).group()) if ordered else 1  # type: ignore[union-attr]
    while index < len(lines):
        match = LIST_ITEM_RE.match(lines[index])
        if not match or len(match.group(1)) != indent or match.group(2)[0].isdigit() != ordered:
            break
        body = match.group(3)
        candidate_is_task = not ordered and bool(re.match(r"^\[[ xX]\]\s+", body))
        if candidate_is_task != task:
            break
        checked = False
        if task:
            task_match = re.match(r"^\[([ xX])\]\s+(.*)$", body)
            if not task_match:
                break
            checked = task_match.group(1).lower() == "x"
            body = task_match.group(2)
        index += 1
        item_lines = [body]
        while index < len(lines):
            candidate = LIST_ITEM_RE.match(lines[index])
            leading = len(lines[index]) - len(lines[index].lstrip(" "))
            if candidate and len(candidate.group(1)) == indent:
                break
            if lines[index].strip() and leading <= indent:
                break
            strip_count = min(len(lines[index]), indent + 2)
            item_lines.append(lines[index][strip_count:])
            index += 1
        children, _ = _parse_blocks(item_lines, 0, warnings, images)
        if not children or children[0].get("type") != "paragraph":
            children.insert(0, {"type": "paragraph", "content": []})
        item_type = "taskItem" if task else "listItem"
        item: dict[str, Any] = {"type": item_type, "content": children}
        if task:
            item["attrs"] = {"checked": checked}
        items.append(item)
    result: dict[str, Any] = {"type": node_type, "content": items}
    if ordered:
        result["attrs"] = {"start": start_number}
    return result, index


def _parse_table(
    lines: Sequence[str], start: int, warnings: _Warnings, images: list[MarkdownImageReference]
) -> tuple[dict[str, Any], int]:
    header = _split_table_row(lines[start])
    alignments = _split_table_row(lines[start + 1])
    if any(cell.strip().startswith(":") or cell.strip().endswith(":") for cell in alignments):
        warnings.add("table column alignment is not supported and was removed")
    rows = [header]
    index = start + 2
    while index < len(lines) and "|" in lines[index] and lines[index].strip():
        rows.append(_split_table_row(lines[index]))
        index += 1
    width = len(header)
    table_rows: list[dict[str, Any]] = []
    for row_index, row in enumerate(rows):
        if len(row) != width:
            warnings.add("an irregular Markdown table was padded or truncated")
        row = (row + [""] * width)[:width]
        cell_type = "tableHeader" if row_index == 0 else "tableCell"
        cells = [
            {
                "type": cell_type,
                "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None},
                "content": [{"type": "paragraph", "content": _parse_inline(value.strip(), warnings, images)}],
            }
            for value in row
        ]
        table_rows.append({"type": "tableRow", "content": cells})
    return {"type": "table", "content": table_rows}, index


def _split_table_row(line: str) -> list[str]:
    stripped = line.strip().strip("|")
    parts = re.split(r"(?<!\\)\|", stripped)
    return [part.replace("\\|", "|").strip() for part in parts]


def _is_table_separator(line: str) -> bool:
    cells = _split_table_row(line)
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell.strip()) for cell in cells)


def _parse_inline(text: str, warnings: _Warnings, images: list[MarkdownImageReference]) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    plain: list[str] = []

    def flush() -> None:
        if plain:
            nodes.append({"type": "text", "text": "".join(plain)})
            plain.clear()

    index = 0
    while index < len(text):
        if text[index] == "\\" and index + 1 < len(text):
            plain.append(text[index + 1])
            index += 2
            continue
        image = re.match(r'!\[([^]]*)\]\((\S+?)(?:\s+["\'](.*?)["\'])?\)', text[index:])
        if image:
            flush()
            nodes.append(_image_or_link(image.group(1), image.group(2), image.group(3), warnings, images, block=False))
            index += image.end()
            continue
        link = re.match(r'\[([^]]+)\]\((\S+?)(?:\s+["\'](.*?)["\'])?\)', text[index:])
        if link:
            flush()
            link_nodes = _parse_inline(link.group(1), warnings, images)
            parsed_link = urlparse(link.group(2))
            if parsed_link.scheme not in {"http", "https", "mailto"}:
                warnings.add(f"unsupported link '{link.group(2)}' was imported as plain text")
                nodes.extend(link_nodes)
            else:
                for child in link_nodes:
                    if child.get("type") == "text":
                        mark: dict[str, Any] = {"type": "link", "attrs": {"href": link.group(2)}}
                        if link.group(3):
                            mark["attrs"]["title"] = link.group(3)
                        child.setdefault("marks", []).append(mark)
                    nodes.append(child)
            index += link.end()
            continue
        triple = next((delimiter for delimiter in ("***", "___") if text.startswith(delimiter, index)), None)
        if triple:
            end = text.find(triple, index + len(triple))
            if end >= 0:
                flush()
                marked_nodes = _parse_inline(text[index + len(triple) : end], warnings, images)
                for child in marked_nodes:
                    if child.get("type") == "text":
                        child.setdefault("marks", []).extend(({"type": "bold"}, {"type": "italic"}))
                    nodes.append(child)
                index = end + len(triple)
                continue
        matched = False
        for delimiter, mark_type in (("**", "bold"), ("__", "bold"), ("~~", "strike"), ("*", "italic"), ("_", "italic"), ("`", "code")):
            if not text.startswith(delimiter, index):
                continue
            end = text.find(delimiter, index + len(delimiter))
            if end < 0:
                continue
            flush()
            inner = text[index + len(delimiter) : end]
            marked_nodes = ([{"type": "text", "text": inner}] if mark_type == "code" else _parse_inline(inner, warnings, images))
            for child in marked_nodes:
                if child.get("type") == "text":
                    child.setdefault("marks", []).append({"type": mark_type})
                nodes.append(child)
            index = end + len(delimiter)
            matched = True
            break
        if matched:
            continue
        html_mark = re.match(r"<(u|mark)>(.*?)</\1>", text[index:], flags=re.IGNORECASE)
        if html_mark:
            flush()
            warning = "underline" if html_mark.group(1).lower() == "u" else "highlight"
            warnings.add(f"{warning} HTML formatting was removed during Markdown import")
            nodes.extend(_parse_inline(html_mark.group(2), warnings, images))
            index += html_mark.end()
            continue
        html_break = re.match(r"<br\s*/?>", text[index:], flags=re.IGNORECASE)
        if html_break:
            flush()
            nodes.append({"type": "hardBreak"})
            index += html_break.end()
            continue
        html_tag = re.match(r"</?(?:div|p|span)(?:\s+[^>]*)?>", text[index:], flags=re.IGNORECASE)
        if html_tag:
            if "align" in html_tag.group(0).lower() or "text-align" in html_tag.group(0).lower():
                warnings.add("text alignment HTML was removed during Markdown import")
            index += html_tag.end()
            continue
        plain.append(text[index])
        index += 1
    flush()
    return nodes


def _image_or_link(
    alt: str,
    source: str,
    title: str | None,
    warnings: _Warnings,
    images: list[MarkdownImageReference],
    *,
    block: bool,
) -> dict[str, Any]:
    source = source.strip("<>")
    parsed = urlparse(source)
    if parsed.scheme in {"http", "https"}:
        warnings.add(f"remote image '{source}' was converted to a link and was not downloaded")
        text: dict[str, Any] = {
            "type": "text",
            "text": alt or source,
            "marks": [{"type": "link", "attrs": {"href": source}}],
        }
        return {"type": "paragraph", "content": [text]} if block else text
    if parsed.scheme or parsed.netloc or source.startswith("/"):
        warnings.add(f"unsupported image source '{source}' was imported as plain text")
        text = {"type": "text", "text": alt or source}
        return {"type": "paragraph", "content": [text]} if block else text
    placeholder = f"markdown-import://image/{len(images)}"
    reference = MarkdownImageReference(
        placeholder=placeholder,
        source_path=unquote(source).replace("\\", "/"),
        alt=alt,
        title=title,
    )
    images.append(reference)
    attrs: dict[str, Any] = {"src": placeholder, "alt": alt}
    if title:
        attrs["title"] = title
    return {"type": "image", "attrs": attrs}
