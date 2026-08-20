from __future__ import annotations

import hashlib
import os
import re
import zipfile
from dataclasses import dataclass
from html import unescape
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote

from charset_normalizer import from_bytes
from defusedxml import ElementTree
from fastapi import HTTPException
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject


ACTIVE_EPUB_TAGS = {"script", "iframe", "object", "embed", "form"}
REMOTE_REFERENCE = re.compile(r"^(?:https?:)?//", re.IGNORECASE)
CSS_REMOTE = re.compile(
    r"(?:@import\s+(?:url\()?\s*['\"]?(?:https?:)?//|url\(\s*['\"]?(?:https?:)?//)", re.IGNORECASE
)
EPUB_CONTAINER_NS = {"container": "urn:oasis:names:tc:opendocument:xmlns:container"}
OPF_NS = {"opf": "http://www.idpf.org/2007/opf", "dc": "http://purl.org/dc/elements/1.1/"}
SUPPORTED_BOOK_FORMATS = {"epub", "pdf", "txt", "md", "markdown"}


@dataclass
class PreparedBook:
    title: str
    author: str | None
    page_count: int | None
    search_text: str
    text_units: list[dict[str, Any]]
    cover_bytes: bytes | None = None
    cover_mime_type: str | None = None


@dataclass(frozen=True)
class LocalBookSource:
    path: Path
    original_name: str
    format: str
    size: int
    sha256: str
    mtime_ns: int
    path_hash: str


def inspect_local_book_source(raw_path: str, max_book_bytes: int) -> LocalBookSource:
    """Resolve and validate a desktop-authorized local book path."""
    try:
        path = Path(raw_path).expanduser().resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise HTTPException(404, "source book file not found") from exc
    if not path.is_file():
        raise HTTPException(422, "source book path must be a regular file")
    original_name = path.name[:255]
    book_format = path.suffix.lower().removeprefix(".")
    if book_format not in SUPPORTED_BOOK_FORMATS:
        raise HTTPException(422, "unsupported book format")
    try:
        before = path.stat()
        if before.st_size <= 0:
            raise HTTPException(422, "book file is empty")
        if before.st_size > max_book_bytes:
            raise HTTPException(413, "book exceeds configured size limit")
        digest = hashlib.sha256()
        size = 0
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                size += len(chunk)
                if size > max_book_bytes:
                    raise HTTPException(413, "book exceeds configured size limit")
                digest.update(chunk)
        after = path.stat()
    except HTTPException:
        raise
    except OSError as exc:
        raise HTTPException(404, "source book file not found") from exc
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or size != after.st_size:
        raise HTTPException(409, "source book changed while it was being read")
    normalized_path = os.path.normcase(str(path))
    return LocalBookSource(
        path=path,
        original_name=original_name,
        format=book_format,
        size=size,
        sha256=digest.hexdigest(),
        mtime_ns=after.st_mtime_ns,
        path_hash=hashlib.sha256(normalized_path.encode("utf-8")).hexdigest(),
    )


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _safe_epub_name(name: str) -> str:
    decoded = unquote(name).replace("\\", "/")
    path = PurePosixPath(decoded)
    if path.is_absolute() or ".." in path.parts or not decoded or "\x00" in decoded:
        raise HTTPException(422, "EPUB contains an unsafe path")
    return path.as_posix()


def _epub_member(zf: zipfile.ZipFile, name: str, max_bytes: int = 16 * 1024 * 1024) -> bytes:
    try:
        info = zf.getinfo(name)
    except KeyError as exc:
        raise HTTPException(422, "EPUB references a missing file") from exc
    if info.file_size > max_bytes:
        raise HTTPException(422, "EPUB metadata or chapter is too large")
    return zf.read(info)


def _epub_text(root: ElementTree.Element) -> str:
    text = " ".join(part.strip() for part in root.itertext() if part.strip())
    return re.sub(r"\s+", " ", unescape(text)).strip()


def _sanitize_epub_xml(raw: bytes) -> tuple[bytes, str]:
    try:
        root = ElementTree.fromstring(raw)
    except ElementTree.ParseError as exc:
        raise HTTPException(422, "EPUB contains invalid XHTML") from exc

    def clean(parent: ElementTree.Element) -> None:
        for child in list(parent):
            if _local_name(child.tag) in ACTIVE_EPUB_TAGS:
                parent.remove(child)
                continue
            clean(child)
        for attribute in list(parent.attrib):
            local = _local_name(attribute)
            value = parent.attrib[attribute].strip()
            if local.startswith("on"):
                del parent.attrib[attribute]
            elif local in {"href", "src", "poster", "action", "formaction"} and (
                REMOTE_REFERENCE.match(value) or value.lower().startswith(("javascript:", "data:text/html"))
            ):
                del parent.attrib[attribute]

    clean(root)
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=True), _epub_text(root)


def sniff_cover(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _prepare_epub(source: Path, reader_target: Path, max_book_bytes: int, max_cover_bytes: int) -> PreparedBook:
    try:
        zf = zipfile.ZipFile(source)
    except (zipfile.BadZipFile, OSError) as exc:
        raise HTTPException(422, "invalid EPUB container") from exc
    with zf:
        infos = zf.infolist()
        if len(infos) > 10_000:
            raise HTTPException(422, "EPUB contains too many files")
        names: set[str] = set()
        total_uncompressed = 0
        for info in infos:
            safe_name = _safe_epub_name(info.filename)
            if safe_name in names:
                raise HTTPException(422, "EPUB contains duplicate file paths")
            names.add(safe_name)
            total_uncompressed += info.file_size
            if info.compress_size and info.file_size / info.compress_size > 200:
                raise HTTPException(422, "EPUB compression ratio is unsafe")
        if total_uncompressed > max(max_book_bytes * 4, 512 * 1024 * 1024):
            raise HTTPException(422, "EPUB expands beyond the safety limit")
        try:
            if zf.read("mimetype") != b"application/epub+zip":
                raise HTTPException(422, "file is not an EPUB")
        except KeyError as exc:
            raise HTTPException(422, "EPUB mimetype is missing") from exc
        if "META-INF/encryption.xml" in names:
            raise HTTPException(422, "encrypted or DRM EPUB files are not supported")
        container_raw = _epub_member(zf, "META-INF/container.xml", 2 * 1024 * 1024)
        try:
            container = ElementTree.fromstring(container_raw)
            rootfile = container.find(".//container:rootfile", EPUB_CONTAINER_NS)
            opf_name = _safe_epub_name(rootfile.attrib["full-path"] if rootfile is not None else "")
            opf_raw = _epub_member(zf, opf_name, 4 * 1024 * 1024)
            opf = ElementTree.fromstring(opf_raw)
        except (ElementTree.ParseError, KeyError) as exc:
            raise HTTPException(422, "EPUB package metadata is invalid") from exc
        title_node = opf.find(".//dc:title", OPF_NS)
        author_node = opf.find(".//dc:creator", OPF_NS)
        title = (title_node.text or "").strip() if title_node is not None else ""
        author = (author_node.text or "").strip() if author_node is not None else None
        base = PurePosixPath(opf_name).parent
        manifest: dict[str, tuple[str, str, str]] = {}
        cover_id: str | None = None
        for item in opf.findall(".//opf:manifest/opf:item", OPF_NS):
            item_id = item.attrib.get("id", "")
            href = item.attrib.get("href", "")
            if not item_id or not href or REMOTE_REFERENCE.match(href):
                continue
            full_name = _safe_epub_name((base / unquote(href)).as_posix())
            manifest[item_id] = (full_name, item.attrib.get("media-type", ""), item.attrib.get("properties", ""))
            if "cover-image" in item.attrib.get("properties", "").split():
                cover_id = item_id
        if cover_id is None:
            for meta in opf.findall(".//opf:metadata/opf:meta", OPF_NS):
                if meta.attrib.get("name") == "cover":
                    cover_id = meta.attrib.get("content")
                    break
        spine_ids = [item.attrib.get("idref", "") for item in opf.findall(".//opf:spine/opf:itemref", OPF_NS)]
        text_units: list[dict[str, Any]] = []
        sanitized: dict[str, bytes] = {}
        for unit_index, item_id in enumerate(spine_ids):
            manifest_item = manifest.get(item_id)
            if not manifest_item:
                continue
            chapter_name, _media_type, _properties = manifest_item
            clean_raw, text = _sanitize_epub_xml(_epub_member(zf, chapter_name))
            sanitized[chapter_name] = clean_raw
            if text:
                text_units.append(
                    {
                        "unit_index": unit_index,
                        "locator": {"kind": "epub", "cfi": "", "href": chapter_name},
                        "text": text,
                        "label": None,
                        "source": "native",
                    }
                )
        for _item_id, (item_name, media_type, _properties) in manifest.items():
            if media_type not in {"application/xhtml+xml", "image/svg+xml", "text/html"}:
                continue
            if item_name not in sanitized:
                sanitized[item_name] = _sanitize_epub_xml(_epub_member(zf, item_name))[0]
        cover_bytes = None
        cover_mime = None
        if cover_id in manifest:
            candidate = _epub_member(zf, manifest[cover_id][0], max_cover_bytes)
            cover_mime = sniff_cover(candidate)
            if cover_mime:
                cover_bytes = candidate
        try:
            with zipfile.ZipFile(reader_target, "w") as output:
                output.writestr("mimetype", b"application/epub+zip", compress_type=zipfile.ZIP_STORED)
                for info in infos:
                    name = _safe_epub_name(info.filename)
                    if name == "mimetype" or name == "META-INF/encryption.xml" or info.is_dir():
                        continue
                    raw = sanitized.get(name, zf.read(info))
                    if name.lower().endswith(".css"):
                        css = raw.decode("utf-8", errors="replace")
                        raw = CSS_REMOTE.sub("/* blocked external resource */", css).encode("utf-8")
                    output.writestr(name, raw, compress_type=zipfile.ZIP_DEFLATED)
        except (OSError, zipfile.BadZipFile) as exc:
            raise HTTPException(422, "could not create safe EPUB reading copy") from exc
        combined = "\n".join(unit["text"] for unit in text_units)
        return PreparedBook(
            title=title,
            author=author,
            page_count=None,
            search_text=combined[:2_000_000],
            text_units=text_units,
            cover_bytes=cover_bytes,
            cover_mime_type=cover_mime,
        )


def _prepare_pdf(source: Path, reader_target: Path) -> PreparedBook:
    try:
        reader = PdfReader(str(source), strict=False)
        if reader.is_encrypted:
            raise HTTPException(422, "encrypted PDF files are not supported")
        page_count = len(reader.pages)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(422, "invalid PDF file") from exc
    if page_count < 1:
        raise HTTPException(422, "PDF has no pages")
    metadata = reader.metadata
    title = str(getattr(metadata, "title", "") or "").strip()
    author = str(getattr(metadata, "author", "") or "").strip() or None
    units: list[dict[str, Any]] = []
    for index, page in enumerate(reader.pages):
        try:
            text = (page.extract_text() or "").strip()
        except Exception:
            text = ""
        if text:
            units.append(
                {
                    "unit_index": index,
                    "locator": {"kind": "pdf", "page_index": index},
                    "text": text,
                    "label": str(index + 1),
                    "source": "native",
                }
            )
    try:
        writer = PdfWriter()
        writer.append_pages_from_reader(reader)
        root = writer.root_object
        root.pop(NameObject("/OpenAction"), None)
        root.pop(NameObject("/AA"), None)
        names_reference = root.get("/Names")
        if names_reference is not None:
            names_reference.get_object().pop(NameObject("/JavaScript"), None)
        acroform_reference = root.get("/AcroForm")
        if acroform_reference is not None:
            acroform = acroform_reference.get_object()
            acroform.pop(NameObject("/AA"), None)
            acroform.pop(NameObject("/XFA"), None)
        for page in writer.pages:
            page.pop(NameObject("/AA"), None)
            annotations = page.get("/Annots") or []
            for annotation_reference in annotations:
                annotation = annotation_reference.get_object()
                action = annotation.get("/A")
                if action is not None and str(action.get_object().get("/S")) == "/JavaScript":
                    annotation.pop(NameObject("/A"), None)
        with reader_target.open("wb") as output:
            writer.write(output)
    except Exception as exc:
        raise HTTPException(422, "could not create safe PDF reading copy") from exc
    combined = "\n".join(unit["text"] for unit in units)
    return PreparedBook(
        title=title,
        author=author,
        page_count=page_count,
        search_text=combined[:2_000_000],
        text_units=units,
    )


def _prepare_text(source: Path, reader_target: Path) -> PreparedBook:
    with source.open("rb") as stream:
        sample = stream.read(1024 * 1024)
    if b"\x00" in sample:
        raise HTTPException(422, "text book appears to be binary")
    match = from_bytes(sample).best()
    encoding = match.encoding if match and match.encoding else "utf-8"
    try:
        with source.open("r", encoding=encoding, errors="strict", newline=None) as input_stream, reader_target.open(
            "w", encoding="utf-8", newline="\n"
        ) as output_stream:
            unit_index = 0
            offset = 0
            units: list[dict[str, Any]] = []
            search_parts: list[str] = []
            search_length = 0
            while chunk := input_stream.read(100_000):
                output_stream.write(chunk)
                end = offset + len(chunk)
                units.append(
                    {
                        "unit_index": unit_index,
                        "locator": {"kind": "text", "start": offset, "end": end},
                        "text": chunk,
                        "label": None,
                        "source": "native",
                    }
                )
                if search_length < 2_000_000:
                    search_parts.append(chunk)
                    search_length += len(chunk)
                offset = end
                unit_index += 1
    except (LookupError, UnicodeDecodeError) as exc:
        raise HTTPException(422, "text encoding could not be decoded") from exc
    return PreparedBook(
        title="",
        author=None,
        page_count=None,
        search_text="".join(search_parts)[:2_000_000],
        text_units=units,
    )


def prepare_book_file(
    source_path: Path,
    original_name: str,
    reader_target: Path,
    max_book_bytes: int,
    max_cover_bytes: int = 5 * 1024 * 1024,
) -> PreparedBook:
    """Validate an original book and create its safe, normalized reading copy."""
    book_format = Path(original_name).suffix.lower().removeprefix(".")
    with source_path.open("rb") as stream:
        header = stream.read(8)
    if book_format == "pdf":
        if not header.startswith(b"%PDF-"):
            raise HTTPException(422, "file content does not match PDF format")
        return _prepare_pdf(source_path, reader_target)
    if book_format == "epub":
        if not header.startswith(b"PK"):
            raise HTTPException(422, "file content does not match EPUB format")
        return _prepare_epub(source_path, reader_target, max_book_bytes, max_cover_bytes)
    if book_format in {"txt", "md", "markdown"}:
        return _prepare_text(source_path, reader_target)
    raise HTTPException(422, "unsupported book format")
