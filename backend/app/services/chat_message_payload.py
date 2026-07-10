from __future__ import annotations

import base64
import mimetypes
from pathlib import Path
from typing import TYPE_CHECKING, Any

from backend.app.storage import AttachmentRecord

if TYPE_CHECKING:
    from backend.app.storage import StorageRepositories

MAX_IMAGE_ATTACHMENTS_PER_TURN = 8
MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024
SUPPORTED_IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
CURRENT_TURN_MESSAGE_MARKER = "_keydex_current_turn"


def attachment_ids_from_request(raw_attachments: list[dict[str, Any]]) -> list[str]:
    attachment_ids: list[str] = []
    for index, raw in enumerate(raw_attachments):
        attachment_id = str(raw.get("attachment_id") or raw.get("id") or "").strip()
        if not attachment_id:
            raise ValueError(f"attachments[{index}].attachment_id 不能为空")
        if attachment_id not in attachment_ids:
            attachment_ids.append(attachment_id)
    return attachment_ids


def attachment_payload(record: AttachmentRecord) -> dict[str, Any]:
    return {
        "id": record.id,
        "attachment_id": record.id,
        "type": record.type,
        "source": record.source,
        "name": record.name,
        "path": record.path,
        "mime_type": record.mime_type,
        "size": record.size,
    }


def validate_image_attachment_record(record: AttachmentRecord) -> None:
    target = Path(record.path)
    if not target.exists() or not target.is_file():
        raise ValueError(f"图片附件文件不存在: {record.name}")
    size = target.stat().st_size
    if size <= 0:
        raise ValueError(f"图片附件为空: {record.name}")
    if size > MAX_IMAGE_ATTACHMENT_BYTES:
        raise ValueError(f"图片附件过大: {record.name}")
    image_mime_from_record(record, target)


def image_mime_from_record(record: AttachmentRecord, target: Path) -> str:
    declared = (record.mime_type or "").split(";", 1)[0].strip().lower()
    guessed = (mimetypes.guess_type(record.name or target.name)[0] or "").lower()
    mime_type = declared if declared.startswith("image/") else guessed
    if mime_type == "image/jpg":
        mime_type = "image/jpeg"
    if mime_type not in SUPPORTED_IMAGE_MIME_TYPES:
        raise ValueError(f"不支持的图片格式: {record.name}")
    return mime_type


def build_user_runtime_message(
    text: str,
    image_attachments: list[AttachmentRecord],
) -> dict[str, Any] | None:
    stripped = text.strip()
    if not image_attachments:
        if not stripped:
            return None
        return {"role": "user", "content": text, CURRENT_TURN_MESSAGE_MARKER: True}

    content: list[dict[str, Any]] = []
    if stripped:
        content.append({"type": "text", "text": text})
    for record in image_attachments:
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": attachment_data_url(record)},
            }
        )
    return {"role": "user", "content": content, CURRENT_TURN_MESSAGE_MARKER: True}


def attachment_data_url(record: AttachmentRecord) -> str:
    target = Path(record.path)
    validate_image_attachment_record(record)
    mime_type = image_mime_from_record(record, target)
    encoded = base64.b64encode(target.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def resolve_image_attachments(
    repositories: StorageRepositories,
    raw_attachments: list[dict[str, Any]],
    *,
    session_id: str,
    user_id: str,
) -> tuple[list[AttachmentRecord], list[dict[str, Any]]]:
    if not raw_attachments:
        return [], []
    attachment_ids = attachment_ids_from_request(raw_attachments)
    if len(attachment_ids) > MAX_IMAGE_ATTACHMENTS_PER_TURN:
        raise ValueError(f"单次最多发送 {MAX_IMAGE_ATTACHMENTS_PER_TURN} 张图片")

    repositories.attachments.claim_for_session(
        attachment_ids,
        session_id=session_id,
        user_id=user_id,
    )
    records_by_id = {
        record.id: record for record in repositories.attachments.list_by_ids(attachment_ids)
    }
    ordered_records: list[AttachmentRecord] = []
    for attachment_id in attachment_ids:
        record = records_by_id.get(attachment_id)
        if record is None:
            raise ValueError("图片附件不存在或已删除")
        if record.user_id != user_id:
            raise ValueError("图片附件不属于当前用户")
        if record.session_id and record.session_id != session_id:
            raise ValueError("图片附件不属于当前会话")
        if record.type != "image":
            raise ValueError("仅支持图片附件发送给模型")
        validate_image_attachment_record(record)
        ordered_records.append(record)
    return ordered_records, [attachment_payload(record) for record in ordered_records]
