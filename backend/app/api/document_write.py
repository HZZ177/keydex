from __future__ import annotations

import hashlib
import os
import stat
import tempfile
import threading
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from backend.app.api.document_read import (
    DocumentReadErrorCode,
    DocumentReadSnapshotError,
    read_stable_utf8_document_snapshot,
)

DOCUMENT_WRITE_PROTOCOL_VERSION = "document-write/v1"
_DOCUMENT_WRITE_LOCK = threading.Lock()


class DocumentWriteErrorCode(StrEnum):
    NOT_FOUND = "not_found"
    TOO_LARGE = "too_large"
    UNSUPPORTED_ENCODING = "unsupported_encoding"
    REVISION_CONFLICT = "revision_conflict"
    INVALID_REQUEST = "invalid_request"
    IO_ERROR = "io_error"


class DocumentWriteRequest(BaseModel):
    protocol_version: Literal["document-write/v1"] = DOCUMENT_WRITE_PROTOCOL_VERSION
    path: str = Field(min_length=1)
    content: str
    expected_revision: str = Field(min_length=1)


class DocumentWriteResponse(BaseModel):
    protocol_version: Literal["document-write/v1"] = DOCUMENT_WRITE_PROTOCOL_VERSION
    path: str
    revision: str
    encoding: Literal["utf-8"] = "utf-8"
    total_bytes: int = Field(ge=0)


@dataclass(frozen=True, slots=True)
class DocumentWriteResult:
    path: str
    revision: str
    total_bytes: int


class DocumentWriteError(Exception):
    def __init__(
        self,
        code: DocumentWriteErrorCode,
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


def write_utf8_document(
    target: Path,
    *,
    public_path: str,
    content: str,
    expected_revision: str,
    max_bytes: int,
) -> DocumentWriteResult:
    with _DOCUMENT_WRITE_LOCK:
        return _write_utf8_document_locked(
            target,
            public_path=public_path,
            content=content,
            expected_revision=expected_revision,
            max_bytes=max_bytes,
        )


def _write_utf8_document_locked(
    target: Path,
    *,
    public_path: str,
    content: str,
    expected_revision: str,
    max_bytes: int,
) -> DocumentWriteResult:
    data = content.encode("utf-8")
    if len(data) > max_bytes:
        raise DocumentWriteError(
            DocumentWriteErrorCode.TOO_LARGE,
            "Document exceeds the preview write limit",
            retryable=False,
            details={"actual_bytes": len(data), "max_bytes": max_bytes},
        )

    try:
        snapshot = read_stable_utf8_document_snapshot(
            target,
            public_path=public_path,
            max_bytes=max_bytes,
        )
    except DocumentReadSnapshotError as exc:
        raise _write_error_from_snapshot_error(exc) from exc

    if snapshot.revision != expected_revision:
        raise DocumentWriteError(
            DocumentWriteErrorCode.REVISION_CONFLICT,
            "Document revision no longer matches the edited revision",
            retryable=True,
            details={
                "expected_revision": expected_revision,
                "actual_revision": snapshot.revision,
            },
        )

    try:
        target_stat = target.stat()
        descriptor, temporary_name = tempfile.mkstemp(
            dir=target.parent,
            prefix=f".{target.name}.keydex-",
            suffix=".tmp",
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, stat.S_IMODE(target_stat.st_mode))
            os.replace(temporary, target)
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
    except FileNotFoundError as exc:
        raise DocumentWriteError(
            DocumentWriteErrorCode.NOT_FOUND,
            "Document does not exist",
            retryable=False,
        ) from exc
    except PermissionError as exc:
        raise DocumentWriteError(
            DocumentWriteErrorCode.IO_ERROR,
            "Document cannot be written",
            retryable=False,
            details={"errno": exc.errno},
        ) from exc
    except OSError as exc:
        raise DocumentWriteError(
            DocumentWriteErrorCode.IO_ERROR,
            "Document cannot be written",
            retryable=True,
            details={"errno": exc.errno},
        ) from exc

    return DocumentWriteResult(
        path=public_path,
        revision=f"sha256:{hashlib.sha256(data).hexdigest()}",
        total_bytes=len(data),
    )


def document_write_response(result: DocumentWriteResult) -> DocumentWriteResponse:
    return DocumentWriteResponse(
        path=result.path,
        revision=result.revision,
        total_bytes=result.total_bytes,
    )


def _write_error_from_snapshot_error(exc: DocumentReadSnapshotError) -> DocumentWriteError:
    code = {
        DocumentReadErrorCode.NOT_FOUND: DocumentWriteErrorCode.NOT_FOUND,
        DocumentReadErrorCode.TOO_LARGE: DocumentWriteErrorCode.TOO_LARGE,
        DocumentReadErrorCode.UNSUPPORTED_ENCODING: DocumentWriteErrorCode.UNSUPPORTED_ENCODING,
        DocumentReadErrorCode.INVALID_REQUEST: DocumentWriteErrorCode.INVALID_REQUEST,
    }.get(exc.code, DocumentWriteErrorCode.IO_ERROR)
    return DocumentWriteError(
        code,
        exc.message,
        retryable=exc.retryable,
        details=exc.details,
    )
