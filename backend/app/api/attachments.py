from __future__ import annotations

import base64
import mimetypes
import re
import shutil
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from backend.app.api.dependencies import get_app_settings, get_repositories
from backend.app.core.config import AppSettings
from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.storage import AttachmentRecord, StorageRepositories

router = APIRouter(prefix="/api/attachments", tags=["attachments"])
RepositoriesDep = Depends(get_repositories)
SettingsDep = Depends(get_app_settings)

MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024
MAX_LOCAL_FILE_BYTES = 100 * 1024 * 1024
SUPPORTED_IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
SUPPORTED_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._ -]+")


class AttachmentResponse(BaseModel):
    id: str
    attachment_id: str
    session_id: str | None = None
    user_id: str
    type: str
    source: str
    name: str
    path: str
    mime_type: str
    size: int
    created_at: str
    updated_at: str


class AttachmentMediaResponse(BaseModel):
    attachment_id: str
    path: str
    name: str
    media_type: str
    mime_type: str
    size: int
    data_url: str


class LocalFileResponse(BaseModel):
    id: str
    source: str
    name: str
    path: str
    mime_type: str
    size: int


class AttachmentDiscardResponse(BaseModel):
    attachment_id: str
    deleted: bool


class RegisterPathRequest(BaseModel):
    path: str = Field(min_length=1)
    name: str | None = None
    source: str = "path"
    session_id: str | None = None
    user_id: str | None = None


class ImportUrlRequest(BaseModel):
    url: str = Field(min_length=1)
    name: str | None = None
    source: str = "url"
    session_id: str | None = None
    user_id: str | None = None


@router.post("/upload", response_model=AttachmentResponse)
async def upload_attachment(
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
    filename: str = Query("image"),
    source: str = Query("pasted"),
    session_id: str | None = Query(None),
    user_id: str | None = Query(None),
    content_type: str | None = Header(None),
) -> AttachmentResponse:
    declared_size = _content_length(request)
    if declared_size is not None:
        _validate_image_size(declared_size)
    body = await request.body()
    _validate_image_size(len(body))
    if not body:
        raise _attachment_error(
            status.HTTP_400_BAD_REQUEST,
            "attachment_empty",
            "图片内容不能为空",
        )

    mime_type = _image_mime(filename, content_type)
    attachment_id = new_id()
    stored_name = _safe_image_name(filename, mime_type)
    target = _stored_attachment_path(settings, attachment_id, stored_name)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(body)
    record = repositories.attachments.create(
        attachment_id=attachment_id,
        session_id=_clean_optional(session_id),
        user_id=_clean_optional(user_id) or settings.default_user_id,
        type="image",
        source=source or "pasted",
        name=stored_name,
        path=str(target),
        mime_type=mime_type,
        size=len(body),
    )
    logger.debug(
        "[AttachmentsAPI] 上传图片附件 | "
        f"attachment_id={record.id} | source={record.source} | size={record.size}"
    )
    return _attachment_response(record)


@router.post("/local-file", response_model=LocalFileResponse)
async def upload_local_file(
    request: Request,
    settings: AppSettings = SettingsDep,
    filename: str = Query("file"),
    source: str = Query("pasted"),
    content_type: str | None = Header(None),
) -> LocalFileResponse:
    declared_size = _content_length(request)
    if declared_size is not None:
        _validate_local_file_size(declared_size)
    body = await request.body()
    _validate_local_file_size(len(body))

    local_file_id = new_id()
    stored_name = _safe_file_name(filename or "file")
    target = _stored_local_file_path(settings, local_file_id, stored_name)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(body)
    mime_type = _file_mime(stored_name, content_type)
    logger.debug(
        "[AttachmentsAPI] 保存本地文件上下文 | "
        f"local_file_id={local_file_id} | source={source or 'pasted'} | size={len(body)}"
    )
    return LocalFileResponse(
        id=local_file_id,
        source=source or "pasted",
        name=stored_name,
        path=str(target),
        mime_type=mime_type,
        size=len(body),
    )


@router.post("/register-path", response_model=AttachmentResponse)
def register_attachment_path(
    payload: RegisterPathRequest,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> AttachmentResponse:
    target = _resolve_existing_file(payload.path)
    size = target.stat().st_size
    _validate_image_size(size)
    mime_type = _image_mime(target.name, None)
    name = _safe_image_name(payload.name or target.name, mime_type)
    record = repositories.attachments.create(
        session_id=_clean_optional(payload.session_id),
        user_id=_clean_optional(payload.user_id) or settings.default_user_id,
        type="image",
        source=payload.source or "path",
        name=name,
        path=str(target),
        mime_type=mime_type,
        size=size,
    )
    logger.debug(
        "[AttachmentsAPI] 注册图片路径附件 | "
        f"attachment_id={record.id} | path={record.path} | size={record.size}"
    )
    return _attachment_response(record)


@router.post("/import-url", response_model=AttachmentResponse)
async def import_attachment_url(
    payload: ImportUrlRequest,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> AttachmentResponse:
    parsed = urlparse(payload.url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise _attachment_error(
            status.HTTP_400_BAD_REQUEST,
            "attachment_url_invalid",
            "图片 URL 不合法",
        )

    async with httpx.AsyncClient(follow_redirects=True, timeout=20.0) as client:
        response = await client.get(str(payload.url))
    if response.status_code >= 400:
        raise _attachment_error(
            status.HTTP_400_BAD_REQUEST,
            "attachment_url_fetch_failed",
            "无法下载图片 URL",
            {"status_code": response.status_code},
        )

    body = response.content
    _validate_image_size(len(body))
    content_type = response.headers.get("content-type")
    url_name = Path(parsed.path).name or "image"
    mime_type = _image_mime(payload.name or url_name, content_type)
    attachment_id = new_id()
    stored_name = _safe_image_name(payload.name or url_name, mime_type)
    target = _stored_attachment_path(settings, attachment_id, stored_name)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(body)
    record = repositories.attachments.create(
        attachment_id=attachment_id,
        session_id=_clean_optional(payload.session_id),
        user_id=_clean_optional(payload.user_id) or settings.default_user_id,
        type="image",
        source=payload.source or "url",
        name=stored_name,
        path=str(target),
        mime_type=mime_type,
        size=len(body),
    )
    logger.debug(
        "[AttachmentsAPI] 导入 URL 图片附件 | "
        f"attachment_id={record.id} | url={payload.url} | size={record.size}"
    )
    return _attachment_response(record)


@router.get("/{attachment_id}/media", response_model=AttachmentMediaResponse)
def read_attachment_media(
    attachment_id: str,
    repositories: StorageRepositories = RepositoriesDep,
) -> AttachmentMediaResponse:
    record = repositories.attachments.get(attachment_id)
    if record is None or record.type != "image":
        raise _attachment_error(
            status.HTTP_404_NOT_FOUND,
            "attachment_not_found",
            "附件不存在",
        )
    target = Path(record.path)
    if not target.exists() or not target.is_file():
        raise _attachment_error(
            status.HTTP_404_NOT_FOUND,
            "attachment_file_missing",
            "附件文件不存在",
        )
    size = target.stat().st_size
    _validate_image_size(size)
    mime_type = _image_mime(record.name or target.name, record.mime_type)
    data_url = f"data:{mime_type};base64,{base64.b64encode(target.read_bytes()).decode('ascii')}"
    return AttachmentMediaResponse(
        attachment_id=record.id,
        path=record.path,
        name=record.name,
        media_type=mime_type,
        mime_type=mime_type,
        size=size,
        data_url=data_url,
    )


@router.delete(
    "/{attachment_id}/unreferenced-web-annotation",
    response_model=AttachmentDiscardResponse,
)
def discard_unreferenced_web_annotation_attachment(
    attachment_id: str,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> AttachmentDiscardResponse:
    record = repositories.attachments.get(attachment_id)
    if record is None:
        return AttachmentDiscardResponse(attachment_id=attachment_id, deleted=False)
    if record.source != "web_annotation":
        raise _attachment_error(
            status.HTTP_409_CONFLICT,
            "attachment_discard_source_forbidden",
            "只能清理尚未发送的网页引用附件",
        )
    managed_directory = _managed_attachment_directory(settings, record)
    outcome, deleted_record = (
        repositories.attachments.hard_delete_unreferenced_web_annotation(attachment_id)
    )
    if outcome == "not_found":
        return AttachmentDiscardResponse(attachment_id=attachment_id, deleted=False)
    if outcome == "source_forbidden":
        raise _attachment_error(
            status.HTTP_409_CONFLICT,
            "attachment_discard_source_forbidden",
            "只能清理尚未发送的网页引用附件",
        )
    if outcome == "referenced":
        raise _attachment_error(
            status.HTTP_409_CONFLICT,
            "attachment_discard_referenced",
            "网页引用附件已经进入任务记录，不能清理",
        )
    if deleted_record is None:
        raise RuntimeError("删除网页引用附件后缺少附件记录")
    try:
        shutil.rmtree(managed_directory)
    except FileNotFoundError:
        pass
    except OSError as exc:
        logger.warning(
            "[AttachmentsAPI] 清理网页引用附件文件失败 | "
            f"attachment_id={attachment_id} | error={exc}"
        )
        raise _attachment_error(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "attachment_discard_file_failed",
            "网页引用附件记录已清理，但临时文件删除失败",
        ) from exc
    return AttachmentDiscardResponse(attachment_id=attachment_id, deleted=True)


def _attachment_response(record: AttachmentRecord) -> AttachmentResponse:
    return AttachmentResponse(
        id=record.id,
        attachment_id=record.id,
        session_id=record.session_id,
        user_id=record.user_id,
        type=record.type,
        source=record.source,
        name=record.name,
        path=record.path,
        mime_type=record.mime_type,
        size=record.size,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def _content_length(request: Request) -> int | None:
    raw = request.headers.get("content-length")
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _validate_image_size(size: int) -> None:
    if size <= 0:
        raise _attachment_error(
            status.HTTP_400_BAD_REQUEST,
            "attachment_empty",
            "图片内容不能为空",
        )
    if size > MAX_IMAGE_ATTACHMENT_BYTES:
        raise _attachment_error(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            "attachment_too_large",
            "图片过大，暂不支持发送",
            {"max_bytes": MAX_IMAGE_ATTACHMENT_BYTES, "size": size},
        )


def _validate_local_file_size(size: int) -> None:
    if size <= 0:
        raise _attachment_error(
            status.HTTP_400_BAD_REQUEST,
            "local_file_empty",
            "文件内容不能为空",
        )
    if size > MAX_LOCAL_FILE_BYTES:
        raise _attachment_error(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            "local_file_too_large",
            "文件过大，暂不支持添加",
            {"max_bytes": MAX_LOCAL_FILE_BYTES, "size": size},
        )


def _image_mime(name: str, declared_mime: str | None) -> str:
    declared = (declared_mime or "").split(";", 1)[0].strip().lower()
    guessed = (mimetypes.guess_type(name)[0] or "").lower()
    mime_type = declared if declared.startswith("image/") else guessed
    if mime_type == "image/jpg":
        mime_type = "image/jpeg"
    suffix = Path(name).suffix.lower()
    if mime_type not in SUPPORTED_IMAGE_MIME_TYPES and suffix in SUPPORTED_IMAGE_SUFFIXES:
        mime_type = mimetypes.guess_type(f"image{suffix}")[0] or mime_type
    if mime_type not in SUPPORTED_IMAGE_MIME_TYPES:
        raise _attachment_error(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "attachment_unsupported_image",
            "仅支持 PNG、JPEG、WebP、GIF 图片",
        )
    return mime_type


def _file_mime(name: str, declared_mime: str | None) -> str:
    declared = (declared_mime or "").split(";", 1)[0].strip().lower()
    if declared:
        return declared
    return (mimetypes.guess_type(name)[0] or "application/octet-stream").lower()


def _safe_image_name(name: str, mime_type: str) -> str:
    raw_name = Path((name or "image").replace("\\", "/")).name or "image"
    cleaned = SAFE_FILENAME_RE.sub("_", raw_name).strip(" .") or "image"
    suffix = Path(cleaned).suffix.lower()
    if suffix not in SUPPORTED_IMAGE_SUFFIXES:
        cleaned = f"{cleaned}{mimetypes.guess_extension(mime_type) or '.png'}"
    return cleaned[:180]


def _safe_file_name(name: str) -> str:
    raw_name = Path((name or "file").replace("\\", "/")).name or "file"
    return (SAFE_FILENAME_RE.sub("_", raw_name).strip(" .") or "file")[:180]


def _stored_attachment_path(settings: AppSettings, attachment_id: str, name: str) -> Path:
    return settings.data_dir / "attachments" / attachment_id / name


def _stored_local_file_path(settings: AppSettings, local_file_id: str, name: str) -> Path:
    return settings.data_dir / "local-files" / local_file_id / name


def _managed_attachment_directory(settings: AppSettings, record: AttachmentRecord) -> Path:
    root = (settings.data_dir / "attachments").resolve()
    directory = (root / record.id).resolve()
    target = Path(record.path).resolve()
    expected_target = (directory / record.name).resolve()
    if directory.parent != root or target != expected_target:
        raise _attachment_error(
            status.HTTP_409_CONFLICT,
            "attachment_discard_unmanaged_path",
            "网页引用附件不在 Keydex 受管目录中，拒绝清理",
        )
    return directory


def _resolve_existing_file(path: str) -> Path:
    try:
        target = Path(path).expanduser().resolve(strict=True)
    except OSError as exc:
        raise _attachment_error(
            status.HTTP_404_NOT_FOUND,
            "attachment_path_not_found",
            "图片文件不存在",
        ) from exc
    if not target.is_file():
        raise _attachment_error(
            status.HTTP_400_BAD_REQUEST,
            "attachment_path_not_file",
            "附件路径不是文件",
        )
    return target


def _clean_optional(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _attachment_error(
    status_code: int,
    code: str,
    message: str,
    details: dict[str, object] | None = None,
) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message, "details": details or {}},
    )
