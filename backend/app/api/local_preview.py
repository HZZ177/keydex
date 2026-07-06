from __future__ import annotations

import base64
import mimetypes
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from backend.app.core.logger import logger

router = APIRouter(tags=["local-preview"])

MAX_LOCAL_PREVIEW_TEXT_BYTES = 512 * 1024
MAX_LOCAL_PREVIEW_MEDIA_BYTES = 2 * 1024 * 1024


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


@router.get("/api/local-preview/media", response_model=LocalPreviewMediaResponse)
async def read_local_preview_media(path: str = Query(..., min_length=1)) -> LocalPreviewMediaResponse:
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


def _local_preview_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={
            "code": code,
            "message": message,
            "details": {},
        },
    )
