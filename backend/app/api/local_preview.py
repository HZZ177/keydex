from __future__ import annotations

import asyncio
import base64
import mimetypes
from pathlib import Path
from typing import Any, BinaryIO

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.app.api.document_read import (
    DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES,
    DocumentReadErrorCode,
    DocumentReadRequest,
    DocumentReadSnapshot,
    DocumentReadSnapshotError,
    DocumentReadSource,
    create_document_read_response,
    read_stable_utf8_document_snapshot,
)
from backend.app.core.logger import logger

router = APIRouter(tags=["local-preview"])

MAX_LOCAL_PREVIEW_TEXT_BYTES = 512 * 1024
MAX_LOCAL_PREVIEW_MEDIA_BYTES = 2 * 1024 * 1024
MAX_LOCAL_PREVIEW_DOCUMENT_BYTES = DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES


class LocalPreviewFileResponse(BaseModel):
    path: str
    content: str
    encoding: str


class LocalPreviewMediaResponse(BaseModel):
    path: str
    media_type: str
    size: int
    data_url: str


@router.get("/api/local-preview/read", response_model=LocalPreviewFileResponse)
async def read_local_preview_file(path: str = Query(..., min_length=1)) -> LocalPreviewFileResponse:
    target = _resolve_preview_file(path)
    size = target.stat().st_size
    if size > MAX_LOCAL_PREVIEW_TEXT_BYTES:
        raise _local_preview_error(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            "local_preview_file_too_large",
            "文件过大，暂不预览",
        )
    try:
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise _local_preview_error(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "local_preview_binary_file",
            "文件不是 UTF-8 文本",
        ) from exc
    logger.debug(f"[LocalPreviewAPI] 读取本地文件预览 | path={target} | size={size}")
    return LocalPreviewFileResponse(path=str(target), content=content, encoding="utf-8")


@router.post("/api/local-preview/read/document")
async def read_local_preview_document(payload: DocumentReadRequest) -> StreamingResponse:
    if payload.source is not DocumentReadSource.LOCAL_PREVIEW:
        raise _local_preview_error(
            status.HTTP_400_BAD_REQUEST,
            "invalid_request",
            "Local preview document endpoint requires source=local-preview",
            {"retryable": False},
        )
    target = _resolve_preview_document(payload.path)
    snapshot = await asyncio.to_thread(
        _read_local_document_snapshot,
        target,
        min(payload.max_bytes, MAX_LOCAL_PREVIEW_DOCUMENT_BYTES),
    )
    if payload.expected_revision and payload.expected_revision != snapshot.revision:
        raise _local_preview_error(
            status.HTTP_409_CONFLICT,
            "revision_conflict",
            "Document revision no longer matches the requested revision",
            {
                "retryable": True,
                "expected_revision": payload.expected_revision,
                "actual_revision": snapshot.revision,
            },
        )
    return create_document_read_response(payload, snapshot)


@router.get("/api/local-preview/media", response_model=LocalPreviewMediaResponse)
async def read_local_preview_media(
    path: str = Query(..., min_length=1),
) -> LocalPreviewMediaResponse:
    target = _resolve_preview_file(path)
    size = target.stat().st_size
    if size > MAX_LOCAL_PREVIEW_MEDIA_BYTES:
        raise _local_preview_error(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            "local_preview_media_too_large",
            "图片过大，暂不预览",
        )
    media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    if not media_type.startswith("image/"):
        raise _local_preview_error(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "local_preview_unsupported_media",
            "仅支持预览图片文件",
        )
    encoded = base64.b64encode(target.read_bytes()).decode("ascii")
    logger.debug(
        "[LocalPreviewAPI] 读取本地媒体预览 | "
        f"path={target} | media_type={media_type} | size={size}"
    )
    return LocalPreviewMediaResponse(
        path=str(target),
        media_type=media_type,
        size=size,
        data_url=f"data:{media_type};base64,{encoded}",
    )


def _resolve_preview_file(path: str) -> Path:
    try:
        target = Path(path).expanduser().resolve(strict=True)
    except OSError as exc:
        raise _local_preview_error(
            status.HTTP_404_NOT_FOUND,
            "local_preview_path_not_found",
            "文件不存在",
        ) from exc
    if not target.is_file():
        raise _local_preview_error(
            status.HTTP_400_BAD_REQUEST,
            "local_preview_not_file",
            "路径不是文件",
        )
    return target


def _resolve_preview_document(path: str) -> Path:
    try:
        return Path(path).expanduser().resolve(strict=True)
    except FileNotFoundError as exc:
        raise _local_preview_error(
            status.HTTP_404_NOT_FOUND,
            "not_found",
            "Document does not exist",
            {"retryable": False},
        ) from exc
    except PermissionError as exc:
        raise _local_preview_error(
            status.HTTP_403_FORBIDDEN,
            "io_error",
            "Document path cannot be resolved",
            {"retryable": False, "errno": exc.errno},
        ) from exc
    except OSError as exc:
        raise _local_preview_error(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "io_error",
            "Document path cannot be resolved",
            {"retryable": True, "errno": exc.errno},
        ) from exc


def _read_local_document_snapshot(target: Path, max_bytes: int) -> DocumentReadSnapshot:
    try:
        return read_stable_utf8_document_snapshot(
            target,
            public_path=str(target),
            max_bytes=max_bytes,
            open_file=_open_local_document_file,
            read_open_file=_read_open_local_document,
        )
    except DocumentReadSnapshotError as exc:
        status_code = {
            DocumentReadErrorCode.NOT_FOUND: status.HTTP_404_NOT_FOUND,
            DocumentReadErrorCode.TOO_LARGE: status.HTTP_413_CONTENT_TOO_LARGE,
            DocumentReadErrorCode.UNSUPPORTED_ENCODING: status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            DocumentReadErrorCode.CHANGED_DURING_READ: status.HTTP_409_CONFLICT,
            DocumentReadErrorCode.INVALID_REQUEST: status.HTTP_400_BAD_REQUEST,
            DocumentReadErrorCode.IO_ERROR: (
                status.HTTP_500_INTERNAL_SERVER_ERROR
                if exc.retryable
                else status.HTTP_403_FORBIDDEN
            ),
        }.get(exc.code, status.HTTP_500_INTERNAL_SERVER_ERROR)
        details = {"retryable": exc.retryable, **exc.details}
        if exc.code is DocumentReadErrorCode.TOO_LARGE:
            details["server_max_bytes"] = MAX_LOCAL_PREVIEW_DOCUMENT_BYTES
        raise _local_preview_error(status_code, exc.code.value, exc.message, details) from exc


def _open_local_document_file(target: Path) -> BinaryIO:
    return target.open("rb")


def _read_open_local_document(handle: BinaryIO, limit: int) -> bytes:
    return handle.read(limit)


def _local_preview_error(
    status_code: int,
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={
            "code": code,
            "message": message,
            "details": details or {},
        },
    )
