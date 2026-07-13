from __future__ import annotations

import asyncio
import hashlib
import os
import stat
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Annotated, BinaryIO, Literal

from pydantic import BaseModel, Field
from starlette.responses import StreamingResponse
from starlette.types import Receive, Scope, Send

DOCUMENT_READ_PROTOCOL_VERSION = "document-read/v1"
DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024
DEFAULT_DOCUMENT_CHUNK_BYTES = 256 * 1024


class DocumentReadSource(StrEnum):
    WORKSPACE = "workspace"
    LOCAL_PREVIEW = "local-preview"
    TAURI = "tauri"


class DocumentReadTransport(StrEnum):
    WHOLE = "whole"
    CHUNKED = "chunked"


class DocumentReadErrorCode(StrEnum):
    NOT_FOUND = "not_found"
    TOO_LARGE = "too_large"
    UNSUPPORTED_ENCODING = "unsupported_encoding"
    REVISION_CONFLICT = "revision_conflict"
    CHANGED_DURING_READ = "changed_during_read"
    CANCELLED = "cancelled"
    INVALID_REQUEST = "invalid_request"
    INVALID_CHUNK = "invalid_chunk"
    MISSING_CHUNKS = "missing_chunks"
    IO_ERROR = "io_error"


class DocumentReadRequest(BaseModel):
    protocol_version: Literal["document-read/v1"] = DOCUMENT_READ_PROTOCOL_VERSION
    request_id: str = Field(min_length=1)
    document_id: str = Field(min_length=1)
    source: DocumentReadSource
    path: str = Field(min_length=1)
    expected_revision: str | None = None
    preferred_transport: Literal["auto", "whole", "chunked"] = "auto"
    chunk_size_bytes: int = Field(default=DEFAULT_DOCUMENT_CHUNK_BYTES, ge=4)
    max_bytes: int = Field(default=DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES, ge=0)


class DocumentReadStartMessage(BaseModel):
    protocol_version: Literal["document-read/v1"] = DOCUMENT_READ_PROTOCOL_VERSION
    type: Literal["start"] = "start"
    request_id: str
    document_id: str
    source: DocumentReadSource
    path: str
    revision: str
    encoding: Literal["utf-8"] = "utf-8"
    transport: DocumentReadTransport
    total_bytes: int = Field(ge=0)
    chunk_size_bytes: int = Field(ge=1)
    chunk_count: int = Field(ge=0)


class DocumentReadChunkMessage(BaseModel):
    protocol_version: Literal["document-read/v1"] = DOCUMENT_READ_PROTOCOL_VERSION
    type: Literal["chunk"] = "chunk"
    request_id: str
    document_id: str
    revision: str
    chunk_index: int = Field(ge=0)
    offset_bytes: int = Field(ge=0)
    byte_length: int = Field(ge=0)
    content: str


class DocumentReadCompleteMessage(BaseModel):
    protocol_version: Literal["document-read/v1"] = DOCUMENT_READ_PROTOCOL_VERSION
    type: Literal["complete"] = "complete"
    request_id: str
    document_id: str
    revision: str
    total_bytes: int = Field(ge=0)
    chunk_count: int = Field(ge=0)


class DocumentReadErrorMessage(BaseModel):
    protocol_version: Literal["document-read/v1"] = DOCUMENT_READ_PROTOCOL_VERSION
    type: Literal["error"] = "error"
    request_id: str
    document_id: str
    revision: str | None = None
    code: DocumentReadErrorCode
    message: str
    retryable: bool


DocumentReadMessage = Annotated[
    DocumentReadStartMessage
    | DocumentReadChunkMessage
    | DocumentReadCompleteMessage
    | DocumentReadErrorMessage,
    Field(discriminator="type"),
]


@dataclass(frozen=True, slots=True)
class DocumentReadSnapshot:
    path: str
    revision: str
    data: bytes


class DocumentReadSnapshotError(Exception):
    def __init__(
        self,
        code: DocumentReadErrorCode,
        message: str,
        *,
        retryable: bool,
        details: dict[str, object] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.details = details or {}


def read_stable_utf8_document_snapshot(
    target: Path,
    *,
    public_path: str,
    max_bytes: int,
    open_file: Callable[[Path], BinaryIO] | None = None,
    read_open_file: Callable[[BinaryIO, int], bytes] | None = None,
) -> DocumentReadSnapshot:
    opener = open_file or (lambda path: path.open("rb"))
    reader = read_open_file or (lambda handle, limit: handle.read(limit))
    try:
        handle = opener(target)
    except FileNotFoundError as exc:
        raise DocumentReadSnapshotError(
            DocumentReadErrorCode.NOT_FOUND,
            "Document does not exist",
            retryable=False,
        ) from exc
    except PermissionError as exc:
        raise DocumentReadSnapshotError(
            DocumentReadErrorCode.IO_ERROR,
            "Document cannot be opened",
            retryable=False,
            details={"errno": exc.errno},
        ) from exc
    except IsADirectoryError as exc:
        raise DocumentReadSnapshotError(
            DocumentReadErrorCode.INVALID_REQUEST,
            "Document path is not a file",
            retryable=False,
        ) from exc
    except OSError as exc:
        raise DocumentReadSnapshotError(
            DocumentReadErrorCode.IO_ERROR,
            "Document cannot be opened",
            retryable=True,
            details={"errno": exc.errno},
        ) from exc

    try:
        with handle:
            before = os.fstat(handle.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise DocumentReadSnapshotError(
                    DocumentReadErrorCode.INVALID_REQUEST,
                    "Document path is not a regular file",
                    retryable=False,
                )
            if before.st_size > max_bytes:
                raise _snapshot_too_large(before.st_size, max_bytes)
            data = reader(handle, max_bytes + 1)
            after = os.fstat(handle.fileno())
    except DocumentReadSnapshotError:
        raise
    except PermissionError as exc:
        raise DocumentReadSnapshotError(
            DocumentReadErrorCode.IO_ERROR,
            "Document cannot be read",
            retryable=False,
            details={"errno": exc.errno},
        ) from exc
    except OSError as exc:
        raise DocumentReadSnapshotError(
            DocumentReadErrorCode.IO_ERROR,
            "Document cannot be read",
            retryable=True,
            details={"errno": exc.errno},
        ) from exc

    if len(data) > max_bytes:
        raise _snapshot_too_large(len(data), max_bytes)
    try:
        target_after = target.stat()
    except FileNotFoundError as exc:
        raise _snapshot_changed() from exc
    except OSError as exc:
        raise DocumentReadSnapshotError(
            DocumentReadErrorCode.IO_ERROR,
            "Document state cannot be verified",
            retryable=True,
            details={"errno": exc.errno},
        ) from exc
    if _stat_identity(before) != _stat_identity(after) or _stat_identity(after) != _stat_identity(
        target_after
    ):
        raise _snapshot_changed()
    try:
        data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise DocumentReadSnapshotError(
            DocumentReadErrorCode.UNSUPPORTED_ENCODING,
            "Document is not valid UTF-8 text",
            retryable=False,
        ) from exc
    return DocumentReadSnapshot(
        path=public_path,
        revision="sha256:" + hashlib.sha256(data).hexdigest(),
        data=data,
    )


def _snapshot_too_large(actual_bytes: int, max_bytes: int) -> DocumentReadSnapshotError:
    return DocumentReadSnapshotError(
        DocumentReadErrorCode.TOO_LARGE,
        "Document exceeds the preview read limit",
        retryable=False,
        details={"actual_bytes": actual_bytes, "max_bytes": max_bytes},
    )


def _snapshot_changed() -> DocumentReadSnapshotError:
    return DocumentReadSnapshotError(
        DocumentReadErrorCode.CHANGED_DURING_READ,
        "Document changed while a stable snapshot was being read",
        retryable=True,
    )


def _stat_identity(value: os.stat_result) -> tuple[int, int, int, int]:
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns)


class DocumentReadStreamingResponse(StreamingResponse):
    """Streaming response compatible with the app's BaseHTTPMiddleware wrapper."""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        del scope, receive
        try:
            await self.stream_response(send)
        except OSError:
            return
        if self.background is not None:
            await self.background()


def create_document_read_response(
    request: DocumentReadRequest,
    snapshot: DocumentReadSnapshot,
) -> DocumentReadStreamingResponse:
    transport = (
        DocumentReadTransport.WHOLE
        if request.preferred_transport == "whole"
        or (
            request.preferred_transport == "auto"
            and len(snapshot.data) <= request.chunk_size_bytes
        )
        else DocumentReadTransport.CHUNKED
    )
    spans = (
        []
        if not snapshot.data
        else [(0, len(snapshot.data))]
        if transport is DocumentReadTransport.WHOLE
        else utf8_chunk_spans(
            snapshot.data,
            request.chunk_size_bytes,
            validate_utf8=False,
        )
    )
    return DocumentReadStreamingResponse(
        stream_document_read_messages(request, snapshot, transport, spans),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-store",
            "X-Document-Revision": snapshot.revision,
            "X-Document-Bytes": str(len(snapshot.data)),
        },
    )


async def stream_document_read_messages(
    request: DocumentReadRequest,
    snapshot: DocumentReadSnapshot,
    transport: DocumentReadTransport,
    spans: list[tuple[int, int]],
    should_cancel: Callable[[], Awaitable[bool]] | None = None,
) -> AsyncIterator[str]:
    start_message = DocumentReadStartMessage(
        request_id=request.request_id,
        document_id=request.document_id,
        source=request.source,
        path=snapshot.path,
        revision=snapshot.revision,
        transport=transport,
        total_bytes=len(snapshot.data),
        chunk_size_bytes=(
            max(1, len(snapshot.data))
            if transport is DocumentReadTransport.WHOLE
            else request.chunk_size_bytes
        ),
        chunk_count=len(spans),
    )
    if should_cancel is not None and await should_cancel():
        return
    yield start_message.model_dump_json() + "\n"
    await asyncio.sleep(0)

    for index, (start, end) in enumerate(spans):
        if should_cancel is not None and await should_cancel():
            return
        chunk_message = DocumentReadChunkMessage(
            request_id=request.request_id,
            document_id=request.document_id,
            revision=snapshot.revision,
            chunk_index=index,
            offset_bytes=start,
            byte_length=end - start,
            content=snapshot.data[start:end].decode("utf-8", errors="strict"),
        )
        yield chunk_message.model_dump_json() + "\n"
        await asyncio.sleep(0)

    if should_cancel is not None and await should_cancel():
        return
    complete_message = DocumentReadCompleteMessage(
        request_id=request.request_id,
        document_id=request.document_id,
        revision=snapshot.revision,
        total_bytes=len(snapshot.data),
        chunk_count=len(spans),
    )
    yield complete_message.model_dump_json() + "\n"


def split_utf8_chunks(data: bytes, chunk_size_bytes: int) -> list[tuple[int, str]]:
    return [
        (start, data[start:end].decode("utf-8", errors="strict"))
        for start, end in utf8_chunk_spans(data, chunk_size_bytes)
    ]


def utf8_chunk_spans(
    data: bytes,
    chunk_size_bytes: int,
    *,
    validate_utf8: bool = True,
) -> list[tuple[int, int]]:
    if chunk_size_bytes < 4:
        raise ValueError("chunk_size_bytes must be at least 4")
    if validate_utf8:
        data.decode("utf-8", errors="strict")
    spans: list[tuple[int, int]] = []
    offset = 0
    while offset < len(data):
        end = min(offset + chunk_size_bytes, len(data))
        while end < len(data) and end > offset and data[end] & 0xC0 == 0x80:
            end -= 1
        if end == offset:
            end = min(offset + 1, len(data))
            while end < len(data) and data[end] & 0xC0 == 0x80:
                end += 1
        spans.append((offset, end))
        offset = end
    return spans


def create_document_read_messages(
    *,
    request: DocumentReadRequest,
    revision: str,
    data: bytes,
    transport: DocumentReadTransport | None = None,
) -> list[DocumentReadMessage]:
    if len(data) > request.max_bytes:
        raise ValueError(f"document exceeds preview limit {request.max_bytes}")
    data.decode("utf-8", errors="strict")
    selected = transport or (
        DocumentReadTransport.WHOLE
        if request.preferred_transport == "whole"
        or (request.preferred_transport == "auto" and len(data) <= request.chunk_size_bytes)
        else DocumentReadTransport.CHUNKED
    )
    raw_chunks = (
        [] if not data else [(0, data.decode("utf-8"))]
        if selected == DocumentReadTransport.WHOLE
        else split_utf8_chunks(data, request.chunk_size_bytes)
    )
    start = DocumentReadStartMessage(
        request_id=request.request_id,
        document_id=request.document_id,
        source=request.source,
        path=request.path,
        revision=revision,
        transport=selected,
        total_bytes=len(data),
        chunk_size_bytes=max(1, len(data))
        if selected == DocumentReadTransport.WHOLE
        else request.chunk_size_bytes,
        chunk_count=len(raw_chunks),
    )
    chunks = [
        DocumentReadChunkMessage(
            request_id=request.request_id,
            document_id=request.document_id,
            revision=revision,
            chunk_index=index,
            offset_bytes=offset,
            byte_length=len(content.encode("utf-8")),
            content=content,
        )
        for index, (offset, content) in enumerate(raw_chunks)
    ]
    complete = DocumentReadCompleteMessage(
        request_id=request.request_id,
        document_id=request.document_id,
        revision=revision,
        total_bytes=len(data),
        chunk_count=len(chunks),
    )
    return [start, *chunks, complete]
