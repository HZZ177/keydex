from __future__ import annotations

import asyncio
import base64
import mimetypes
import secrets
from collections import OrderedDict
from pathlib import Path
from threading import Lock
from typing import Any, BinaryIO
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
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
from backend.app.api.document_write import (
    DocumentWriteError,
    DocumentWriteErrorCode,
    DocumentWriteRequest,
    DocumentWriteResponse,
    document_write_content_metadata,
    document_write_response,
    write_utf8_document,
)
from backend.app.core.logger import logger
from backend.app.services.file_change_hub import FileChangeHub

router = APIRouter(tags=["local-preview"])

MAX_LOCAL_PREVIEW_TEXT_BYTES = 512 * 1024
MAX_LOCAL_PREVIEW_MEDIA_BYTES = 2 * 1024 * 1024
MAX_LOCAL_PREVIEW_DOCUMENT_BYTES = DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES
MAX_LOCAL_HTML_PREVIEW_SCOPES = 128
HTML_PREVIEW_VIEWPORT_MESSAGE_TYPE = "keydex:html-preview-viewport-state/v1"
HTML_PREVIEW_VIEWPORT_BRIDGE_MARKER = "data-keydex-preview-viewport-bridge"

_local_html_preview_scopes: OrderedDict[str, Path] = OrderedDict()
_local_html_preview_scopes_lock = Lock()


class LocalPreviewFileResponse(BaseModel):
    path: str
    content: str
    encoding: str


class LocalPreviewMediaResponse(BaseModel):
    path: str
    media_type: str
    size: int
    data_url: str


class LocalHtmlPreviewRequest(BaseModel):
    path: str
    scope_path: str | None = None


class LocalHtmlPreviewResponse(BaseModel):
    path: str
    url: str


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


@router.post(
    "/api/local-preview/html/register",
    response_model=LocalHtmlPreviewResponse,
)
async def register_local_html_preview(
    payload: LocalHtmlPreviewRequest,
    request: Request,
) -> LocalHtmlPreviewResponse:
    target = _resolve_preview_file(payload.path)
    if target.suffix.lower() not in {".html", ".htm"}:
        raise _local_preview_error(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "local_preview_not_html",
            "只能直接预览 HTML 文件",
        )
    scope = _resolve_local_html_preview_scope(target, payload.scope_path)
    token = _register_local_html_preview_scope(scope)
    relative_path = target.relative_to(scope).as_posix()
    asset_path = (
        f"api/local-preview/html/{token}/"
        f"{quote(relative_path, safe='/')}"
    )
    url = f"{str(request.base_url).rstrip('/')}/{asset_path}"
    logger.debug(
        "[LocalPreviewAPI] 注册本地 HTML 预览 | "
        f"path={target} | scope={scope}"
    )
    return LocalHtmlPreviewResponse(path=str(target), url=url)


@router.get(
    "/api/local-preview/html/{token}/{resource_path:path}",
    name="read_local_html_preview_asset",
)
async def read_local_html_preview_asset(token: str, resource_path: str) -> Response:
    scope = _local_html_preview_scope(token)
    target = _resolve_local_html_preview_asset(scope, resource_path)
    if target.suffix.lower() in {".html", ".htm"}:
        try:
            html = target.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            pass
        else:
            return HTMLResponse(
                _with_html_preview_viewport_bridge(html),
                headers={"Cache-Control": "no-store"},
            )
    return FileResponse(
        target,
        media_type=mimetypes.guess_type(target.name)[0] or "application/octet-stream",
        headers={"Cache-Control": "no-store"},
    )


def _with_html_preview_viewport_bridge(html: str) -> str:
    if HTML_PREVIEW_VIEWPORT_BRIDGE_MARKER in html:
        return html
    script = f"""<script {HTML_PREVIEW_VIEWPORT_BRIDGE_MARKER}>(function(){{var type={HTML_PREVIEW_VIEWPORT_MESSAGE_TYPE!r};var frame=0;var last=\"\";function report(){{frame=0;var root=document.scrollingElement||document.documentElement;var viewport=Math.max(window.innerHeight||0,document.documentElement?document.documentElement.clientHeight:0);var scrollHeight=Math.max(root?root.scrollHeight:0,document.documentElement?document.documentElement.scrollHeight:0,document.body?document.body.scrollHeight:0);var scrollTop=Math.max(window.scrollY||0,root?root.scrollTop:0);var threshold=Math.max(72,Math.min(160,viewport*0.12));var nearBottom=viewport>0&&(scrollHeight<=viewport+1||scrollHeight-viewport-scrollTop<=threshold);var key=[nearBottom,Math.round(scrollTop),Math.round(scrollHeight),Math.round(viewport)].join(\":\");if(key===last){{return;}}last=key;window.parent.postMessage({{type:type,nearBottom:nearBottom,scrollTop:scrollTop,scrollHeight:scrollHeight,clientHeight:viewport}},\"*\");}}function schedule(){{if(frame){{return;}}frame=window.requestAnimationFrame(report);}}window.addEventListener(\"scroll\",schedule,{{passive:true}});window.addEventListener(\"resize\",schedule,{{passive:true}});window.addEventListener(\"load\",schedule,{{once:true}});if(typeof ResizeObserver!==\"undefined\"){{var resizeObserver=new ResizeObserver(schedule);if(document.documentElement){{resizeObserver.observe(document.documentElement);}}if(document.body){{resizeObserver.observe(document.body);}}}}if(typeof MutationObserver!==\"undefined\"){{new MutationObserver(schedule).observe(document.documentElement,{{childList:true,subtree:true,attributes:true}});}}schedule();window.setTimeout(schedule,120);window.setTimeout(schedule,600);}})();</script>"""
    lower_html = html.lower()
    body_close_index = lower_html.rfind("</body>")
    if body_close_index >= 0:
        return f"{html[:body_close_index]}{script}{html[body_close_index:]}"
    html_close_index = lower_html.rfind("</html>")
    if html_close_index >= 0:
        return f"{html[:html_close_index]}{script}{html[html_close_index:]}"
    return f"{html}{script}"


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


@router.post("/api/local-preview/write/document", response_model=DocumentWriteResponse)
async def write_local_preview_document(
    payload: DocumentWriteRequest,
    request: Request,
) -> DocumentWriteResponse:
    target = _resolve_preview_document(payload.path)
    hub = getattr(request.app.state, "file_change_hub", None)
    write_echo_registered = bool(payload.write_id and isinstance(hub, FileChangeHub))
    if write_echo_registered:
        revision, total_bytes = document_write_content_metadata(payload.content)
        await hub.register_document_write_echo(
            payload.write_id,
            target,
            revision=revision,
            total_bytes=total_bytes,
        )
    write_completed = False
    try:
        result = await asyncio.to_thread(
            write_utf8_document,
            target,
            public_path=str(target),
            content=payload.content,
            expected_revision=payload.expected_revision,
            max_bytes=MAX_LOCAL_PREVIEW_DOCUMENT_BYTES,
        )
        write_completed = True
    except DocumentWriteError as exc:
        status_code = {
            DocumentWriteErrorCode.NOT_FOUND: status.HTTP_404_NOT_FOUND,
            DocumentWriteErrorCode.TOO_LARGE: status.HTTP_413_CONTENT_TOO_LARGE,
            DocumentWriteErrorCode.UNSUPPORTED_ENCODING: status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            DocumentWriteErrorCode.REVISION_CONFLICT: status.HTTP_409_CONFLICT,
            DocumentWriteErrorCode.INVALID_REQUEST: status.HTTP_400_BAD_REQUEST,
            DocumentWriteErrorCode.IO_ERROR: (
                status.HTTP_500_INTERNAL_SERVER_ERROR
                if exc.retryable
                else status.HTTP_403_FORBIDDEN
            ),
        }[exc.code]
        raise _local_preview_error(
            status_code,
            exc.code.value,
            exc.message,
            {"retryable": exc.retryable, **exc.details},
        ) from exc
    finally:
        if write_echo_registered and not write_completed:
            await hub.discard_document_write_echo(payload.write_id, target)
    logger.info(f"[LocalPreviewAPI] 保存本地文件 | path={target} | size={result.total_bytes}")
    return document_write_response(result)


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


def _resolve_local_html_preview_scope(target: Path, scope_path: str | None) -> Path:
    if not scope_path or not scope_path.strip():
        return target.parent
    try:
        scope = Path(scope_path).expanduser().resolve(strict=True)
    except OSError as exc:
        raise _local_preview_error(
            status.HTTP_404_NOT_FOUND,
            "local_preview_scope_not_found",
            "HTML 预览工作区不存在",
        ) from exc
    if not scope.is_dir():
        raise _local_preview_error(
            status.HTTP_400_BAD_REQUEST,
            "local_preview_scope_not_directory",
            "HTML 预览范围不是目录",
        )
    if not target.is_relative_to(scope):
        raise _local_preview_error(
            status.HTTP_403_FORBIDDEN,
            "local_preview_outside_scope",
            "HTML 文件不在允许预览的工作区内",
        )
    return scope


def _register_local_html_preview_scope(scope: Path) -> str:
    token = secrets.token_urlsafe(18)
    with _local_html_preview_scopes_lock:
        _local_html_preview_scopes[token] = scope
        while len(_local_html_preview_scopes) > MAX_LOCAL_HTML_PREVIEW_SCOPES:
            _local_html_preview_scopes.popitem(last=False)
    return token


def _local_html_preview_scope(token: str) -> Path:
    with _local_html_preview_scopes_lock:
        scope = _local_html_preview_scopes.get(token)
        if scope is not None:
            _local_html_preview_scopes.move_to_end(token)
    if scope is None:
        raise _local_preview_error(
            status.HTTP_404_NOT_FOUND,
            "local_preview_html_session_not_found",
            "HTML 预览地址已失效，请重新打开文件",
        )
    return scope


def _resolve_local_html_preview_asset(scope: Path, resource_path: str) -> Path:
    try:
        target = (scope / resource_path).resolve(strict=True)
    except OSError as exc:
        raise _local_preview_error(
            status.HTTP_404_NOT_FOUND,
            "local_preview_asset_not_found",
            "HTML 预览资源不存在",
        ) from exc
    if not target.is_relative_to(scope):
        raise _local_preview_error(
            status.HTTP_403_FORBIDDEN,
            "local_preview_asset_outside_scope",
            "HTML 预览资源超出允许范围",
        )
    if target.is_dir():
        target = (target / "index.html").resolve(strict=True)
    if not target.is_file():
        raise _local_preview_error(
            status.HTTP_400_BAD_REQUEST,
            "local_preview_asset_not_file",
            "HTML 预览资源不是文件",
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
