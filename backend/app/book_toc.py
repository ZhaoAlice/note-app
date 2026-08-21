from __future__ import annotations

from collections import Counter
from pathlib import Path
import re
from typing import Any, Iterable, Sequence
import unicodedata


TocItem = dict[str, int | str]
PageText = tuple[int, str]

_TOC_MARKER = re.compile(r"^(?:目\s*录|contents?)$", re.IGNORECASE)
_TRAILING_PAGE = re.compile(
    r"^(?P<title>.+?)(?:[.．。…·•_\-—]{2,}|\s+)(?P<page>\d{1,5})\s*$"
)
_CHINESE_HEADING = re.compile(
    r"^第\s*[0-9一二三四五六七八九十百千万零〇两]+\s*(?P<kind>[编篇部章节回])(?:\s+|[、:：.-]?)(?P<title>.*)$"
)
_NUMBERED_HEADING = re.compile(r"^(?P<number>\d+(?:\.\d+){0,3})[、:：.)）]?\s+(?P<title>\S.*)$")
_COMPACT_DEEP_HEADING = re.compile(
    r"^(?P<number>\d+(?:\.\d+){2,3})[、:：.)）]?(?P<title>[^\d\s].*)$"
)
_ENGLISH_CHAPTER = re.compile(r"^(?:chapter|part)\s+[0-9ivxlcdm]+(?:\s*[:.\-—]\s*|\s+).+", re.IGNORECASE)


def normalize_text(value: str) -> str:
    """Normalize PDF/OCR text while preserving line boundaries."""
    value = unicodedata.normalize("NFKC", value or "").replace("\r\n", "\n").replace("\r", "\n")
    lines: list[str] = []
    for raw_line in value.split("\n"):
        line = re.sub(r"[\t\v\f\u00a0\u3000]+", " ", raw_line)
        previous = None
        while previous != line:
            previous = line
            line = re.sub(r"(?<=\d)\s+(?=\d)", "", line)
            line = re.sub(r"(?<=\d)\s*\.\s*(?=\d)", ".", line)
        lines.append(re.sub(r" +", " ", line).strip())
    return "\n".join(lines).strip()


def _clean_label(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[.．。…·•_\-—]+\s*$", "", value)).strip()[:300]


def _heading_level(label: str) -> int | None:
    chinese = _CHINESE_HEADING.match(label)
    if chinese:
        return 2 if chinese.group("kind") == "节" else 1
    numbered = _NUMBERED_HEADING.match(label) or _COMPACT_DEEP_HEADING.match(label)
    if numbered:
        return min(4, numbered.group("number").count(".") + 1)
    if _ENGLISH_CHAPTER.match(label):
        return 1
    return None


def _parse_toc_line(line: str) -> tuple[str, int, int] | None:
    match = _TRAILING_PAGE.match(line)
    if not match:
        return None
    label = _clean_label(match.group("title"))
    level = _heading_level(label)
    if level is None or not label:
        return None
    printed_page = int(match.group("page"))
    if printed_page <= 0:
        return None
    return label, level, printed_page


def _toc_entries(text: str) -> list[tuple[str, int, int]]:
    lines = [line for line in normalize_text(text).splitlines() if line]
    entries: list[tuple[str, int, int]] = []
    pending: str | None = None
    for line in lines:
        if _TOC_MARKER.fullmatch(re.sub(r"\s+", "", line)):
            pending = None
            continue
        parsed = _parse_toc_line(line)
        if parsed is None and pending:
            parsed = _parse_toc_line(f"{pending} {line}")
        if parsed is not None:
            entries.append(parsed)
            pending = None
        elif _heading_level(line) is not None and len(line) <= 200:
            pending = line
        else:
            pending = None
    return entries


def _match_key(value: str) -> str:
    return re.sub(r"[^\w\u3400-\u9fff]+", "", normalize_text(value).casefold())


def _toc_pages(pages: Sequence[PageText]) -> tuple[list[tuple[str, int, int]], int]:
    if not pages:
        return [], -1
    scan_limit = min(len(pages), max(12, min(32, len(pages) // 5 + 4)))
    start: int | None = None
    for position, (_page_index, text) in enumerate(pages[:scan_limit]):
        lines = [re.sub(r"\s+", "", line) for line in normalize_text(text).splitlines()]
        if any(_TOC_MARKER.fullmatch(line) for line in lines):
            start = position
            break
    if start is None:
        return [], -1

    collected: list[tuple[str, int, int]] = []
    toc_end = pages[start][0]
    empty_pages = 0
    for page_index, text in pages[start : min(len(pages), start + 12)]:
        entries = _toc_entries(text)
        if entries:
            collected.extend(entries)
            toc_end = page_index
            empty_pages = 0
        else:
            empty_pages += 1
            if collected and empty_pages >= 2:
                break
    return collected, toc_end


def _fallback_headings(pages: Sequence[PageText], *, after_page: int = -1) -> list[TocItem]:
    items: list[TocItem] = []
    seen: set[str] = set()
    for page_index, text in pages:
        if page_index <= after_page:
            continue
        lines = [line for line in normalize_text(text).splitlines() if line][:12]
        first_level = _heading_level(_clean_label(lines[0])) if lines else None
        for position, line in enumerate(lines):
            label = _clean_label(line)
            level = _heading_level(label)
            if level is None or len(label) > 300:
                continue
            if position > 0 and (first_level is None or level <= first_level):
                continue
            key = _match_key(label)
            if not key or key in seen:
                continue
            seen.add(key)
            items.append(
                {"id": f"inferred-{len(items) + 1}", "label": label, "level": level, "page_index": page_index}
            )
    return items


def infer_toc(pages: Sequence[PageText], page_count: int | None = None) -> list[TocItem]:
    """Infer a conservative PDF TOC from indexed page text."""
    ordered = sorted(((int(index), text or "") for index, text in pages if int(index) >= 0), key=lambda item: item[0])
    if not ordered:
        return []
    total_pages = page_count if page_count and page_count > 0 else ordered[-1][0] + 1
    printed_entries, toc_end = _toc_pages(ordered)
    if not printed_entries:
        return _fallback_headings(ordered)

    page_prefixes = [
        (index, _match_key("\n".join(normalize_text(text).splitlines()[:12]))[:1200])
        for index, text in ordered
        if index > toc_end
    ]
    direct: dict[int, int] = {}
    offsets: list[int] = []
    next_minimum = toc_end + 1
    for entry_index, (label, _level, printed_page) in enumerate(printed_entries):
        key = _match_key(label)
        if len(key) < 2:
            continue
        for actual_page, prefix in page_prefixes:
            if actual_page < next_minimum:
                continue
            if key in prefix:
                direct[entry_index] = actual_page
                offsets.append(actual_page - (printed_page - 1))
                next_minimum = actual_page
                break

    common_offset: int | None = None
    if offsets:
        offset, frequency = Counter(offsets).most_common(1)[0]
        if len(offsets) == 1 or (frequency >= 2 and frequency * 2 > len(offsets)):
            common_offset = offset
    result: list[TocItem] = []
    previous_page = toc_end + 1
    seen: set[tuple[str, int]] = set()
    for entry_index, (label, level, printed_page) in enumerate(printed_entries):
        page_index = direct.get(entry_index)
        if page_index is None and common_offset is not None:
            page_index = printed_page - 1 + common_offset
        if page_index is None or page_index < previous_page or page_index >= total_pages:
            continue
        key = (_match_key(label), page_index)
        if key in seen:
            continue
        seen.add(key)
        previous_page = page_index
        result.append(
            {"id": f"inferred-{len(result) + 1}", "label": label, "level": level, "page_index": page_index}
        )
    if not result:
        return _fallback_headings(ordered, after_page=toc_end)

    # Printed contents often stop at section level. Supplement them with
    # high-confidence third/fourth-level headings found near body page tops.
    known_labels = {_match_key(str(item["label"])) for item in result}
    supplements = [
        item
        for item in _fallback_headings(ordered, after_page=toc_end)
        if int(item["level"]) >= 3 and _match_key(str(item["label"])) not in known_labels
    ]
    merged = sorted([*result, *supplements], key=lambda item: (int(item["page_index"]), int(item["level"])))
    for index, item in enumerate(merged, start=1):
        item["id"] = f"inferred-{index}"
    return merged


def read_pdf_outline(path: Path) -> list[TocItem]:
    """Read and flatten a PDF outline, returning an empty list for unreadable outlines."""
    try:
        from pypdf import PdfReader

        with path.open("rb") as source:
            reader = PdfReader(source)
            nodes: Iterable[Any] = reader.outline or []
            page_count = len(reader.pages)
            items: list[TocItem] = []

            def visit(values: Iterable[Any], level: int) -> None:
                for node in values:
                    if isinstance(node, list):
                        visit(node, level + 1)
                        continue
                    label = _clean_label(str(getattr(node, "title", "")))
                    if not label:
                        continue
                    try:
                        page_index = reader.get_destination_page_number(node)
                    except Exception:
                        continue
                    if page_index is None or page_index < 0 or page_index >= page_count:
                        continue
                    items.append(
                        {
                            "id": f"embedded-{len(items) + 1}",
                            "label": label,
                            "level": max(1, level),
                            "page_index": int(page_index),
                        }
                    )

            visit(nodes, 1)
            return items
    except Exception:
        return []


def pdf_source_candidates(book: Any, book_dir: Path) -> list[Path]:
    candidates: list[Path] = []
    if book.storage_mode == "linked" and book.source_path:
        try:
            candidates.append(Path(book.source_path))
        except (OSError, RuntimeError, ValueError):
            pass
    elif book.storage_name:
        candidates.append(book_dir / book.storage_name)
    candidates.append(book_dir / book.reader_storage_name)
    unique: list[Path] = []
    for candidate in candidates:
        if candidate not in unique:
            unique.append(candidate)
    return unique


def find_embedded_toc(book: Any, book_dir: Path) -> list[TocItem]:
    for path in pdf_source_candidates(book, book_dir):
        if path.is_file():
            items = read_pdf_outline(path)
            if items:
                return items
    return []
