from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
import struct
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.core.time import to_iso_z, utc_now
from backend.app.storage import AttachmentRecord, StorageRepositories
from backend.app.web_annotations.models import (
    StrictWebAnnotationModel,
    WebAnnotationAssetRecord,
    WebAnnotationMessageAttachmentCloneRequest,
    WebAnnotationMessageAttachmentCloneResponse,
    WebAnnotationMessageAttachmentRecord,
    WebAnnotationResourceRecord,
    WebAnnotationScope,
    WebAnnotationSource,
)

MANAGED_CAPTURE_FILE = "capture.png"
MANAGED_CAPTURE_MANIFEST = ".keydex-browser-capture.json"
MAX_MANAGED_CAPTURE_BYTES = 64 * 1024 * 1024
MAX_STAGED_TTL = timedelta(hours=24, minutes=5)
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class WebAnnotationAssetServiceError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


class WebAnnotationAssetRegistration(StrictWebAnnotationModel):
    asset_id: str = Field(pattern=r"^web-capture-[0-9a-f]{32}$")
    kind: Literal["staged"]
    mime_type: Literal["image/png"]
    width: int = Field(gt=0, le=1_000_000)
    height: int = Field(gt=0, le=1_000_000)
    byte_length: int = Field(gt=0, le=MAX_MANAGED_CAPTURE_BYTES)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    expires_at: str

    @field_validator("expires_at")
    @classmethod
    def validate_expiry(cls, value: str) -> str:
        _parse_timestamp(value, "expires_at")
        return value


class WebAnnotationAssetRegistrationRequest(StrictWebAnnotationModel):
    schema_version: Literal[1] = 1
    scope: WebAnnotationScope
    source: WebAnnotationSource
    asset: WebAnnotationAssetRegistration


class _ManifestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True, populate_by_name=True)


class ManagedCaptureSurface(_ManifestModel):
    panel_id: str = Field(alias="panelId", min_length=1, max_length=255)
    surface_id: str = Field(alias="surfaceId", min_length=1, max_length=255)
    generation: int = Field(ge=1)


class ManagedCaptureManifest(_ManifestModel):
    schema_version: Literal[1] = Field(alias="schemaVersion")
    kind: Literal["staged"]
    asset_id: str = Field(alias="assetId", pattern=r"^web-capture-[0-9a-f]{32}$")
    capture_request_id: str = Field(alias="captureRequestId", min_length=1, max_length=255)
    surface: ManagedCaptureSurface
    file_name: Literal["capture.png"] = Field(alias="fileName")
    mime_type: Literal["image/png"] = Field(alias="mimeType")
    width: int = Field(gt=0, le=1_000_000)
    height: int = Field(gt=0, le=1_000_000)
    byte_length: int = Field(alias="byteLength", gt=0, le=MAX_MANAGED_CAPTURE_BYTES)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    created_at: str = Field(alias="createdAt")
    expires_at: str = Field(alias="expiresAt")

    @model_validator(mode="after")
    def validate_lifetime(self) -> ManagedCaptureManifest:
        created_at = _parse_timestamp(self.created_at, "createdAt")
        expires_at = _parse_timestamp(self.expires_at, "expiresAt")
        if expires_at <= created_at or expires_at - created_at > MAX_STAGED_TTL:
            raise ValueError("managed capture lifetime is invalid")
        return self


class WebAnnotationAssetService:
    def __init__(self, repositories: StorageRepositories, *, data_dir: Path) -> None:
        self._repositories = repositories
        self._web = repositories.web_annotations
        self._data_dir = data_dir.resolve()
        self._root = (self._data_dir / "browser" / "captures" / "staged").resolve()

    def register(
        self,
        payload: WebAnnotationAssetRegistrationRequest,
    ) -> WebAnnotationAssetRecord:
        self._require_scope(payload.scope)
        if payload.source.profile_mode != "persistent":
            raise WebAnnotationAssetServiceError(
                "web_annotation_incognito_persistence_forbidden",
                "Incognito captures cannot be registered as persistent assets",
            )
        verified = self._verify_capture(payload.asset.asset_id, expected=payload.asset)
        if _parse_timestamp(verified.expires_at, "expiresAt") <= utc_now():
            raise _asset_conflict(payload.asset.asset_id, "expired")
        storage_path = self._relative_capture_path(payload.asset.asset_id)
        with self._repositories.db.transaction(immediate=True) as conn:
            resource = self._web.resources.upsert(
                scope=payload.scope,
                identity=payload.source.identity(),
                title=payload.source.title,
                canonical_url=payload.source.canonical_url,
                connection=conn,
            )
            current = self._web.assets.get(payload.asset.asset_id, connection=conn)
            if current is not None:
                if self._registration_matches(current, resource, payload.asset, storage_path):
                    return current
                raise _asset_conflict(payload.asset.asset_id, current.state)
            return self._web.assets.stage(
                resource_id=resource.id,
                storage_path=storage_path,
                mime_type=payload.asset.mime_type,
                size_bytes=payload.asset.byte_length,
                sha256=payload.asset.sha256,
                width=payload.asset.width,
                height=payload.asset.height,
                expires_at=payload.asset.expires_at,
                asset_id=payload.asset.asset_id,
                connection=conn,
            )

    def require_for_attach(
        self,
        *,
        asset_ids: list[str],
        resource: WebAnnotationResourceRecord,
        connection: sqlite3.Connection,
    ) -> list[WebAnnotationAssetRecord]:
        records: list[WebAnnotationAssetRecord] = []
        for asset_id in asset_ids:
            record = self._web.assets.get(asset_id, connection=connection)
            if record is None:
                raise _asset_conflict(asset_id, "missing")
            if record.state != "staged" or record.resource_id != resource.id:
                raise _asset_conflict(asset_id, record.state)
            if (
                record.expires_at is None
                or _parse_timestamp(record.expires_at, "expires_at") <= utc_now()
            ):
                raise _asset_conflict(asset_id, "expired")
            self._verify_capture(asset_id, expected=record)
            records.append(record)
        return records

    def attach(
        self,
        *,
        records: list[WebAnnotationAssetRecord],
        annotation_id: str,
        resource_id: str,
        connection: sqlite3.Connection,
    ) -> list[WebAnnotationAssetRecord]:
        attached: list[WebAnnotationAssetRecord] = []
        for record in records:
            updated = self._web.assets.attach(
                asset_id=record.id,
                annotation_id=annotation_id,
                resource_id=resource_id,
                connection=connection,
            )
            if updated is None:
                raise _asset_conflict(record.id, "consumed")
            attached.append(updated)
        return attached

    def delete_staged(self, asset_id: str) -> None:
        record = self._web.assets.get(asset_id)
        if record is None:
            raise WebAnnotationAssetServiceError(
                "web_annotation_asset_not_found",
                "Web annotation asset does not exist",
                {"asset_id": asset_id},
            )
        if record.state != "staged":
            raise _asset_conflict(asset_id, record.state)
        self._remove_managed_capture(record, missing_ok=True)
        if not self._web.assets.delete_staged(asset_id):
            latest = self._web.assets.get(asset_id)
            if latest is not None:
                raise _asset_conflict(asset_id, latest.state)

    def resolve_attached_capture(
        self,
        *,
        annotation_id: str,
        asset_id: str,
        resource_id: str,
        connection: sqlite3.Connection,
    ) -> tuple[WebAnnotationAssetRecord, Path]:
        record = self._web.assets.get(asset_id, connection=connection)
        if record is None:
            raise WebAnnotationAssetServiceError(
                "web_annotation_asset_not_found",
                "Web annotation asset does not exist",
                {"asset_id": asset_id},
            )
        if record.state != "attached":
            raise _asset_conflict(asset_id, record.state)
        if record.annotation_id != annotation_id or record.resource_id != resource_id:
            raise WebAnnotationAssetServiceError(
                "web_annotation_scope_forbidden",
                "The requested web annotation evidence is outside the target scope",
                {"annotation_id": annotation_id, "asset_id": asset_id},
            )
        expected_path = self._relative_capture_path(record.id)
        if record.storage_path != expected_path:
            raise _asset_conflict(record.id, "unmanaged_path")
        self._verify_capture(record.id, expected=record)
        return record, self._asset_directory(record.id) / MANAGED_CAPTURE_FILE

    def remove_annotation_assets(self, annotation_id: str) -> None:
        for record in self._web.assets.list_by_annotation(annotation_id):
            self._remove_managed_capture(record, missing_ok=True)

    def cleanup_expired(self, *, limit: int = 100) -> dict[str, int]:
        expired = self._web.assets.list_expired_staged(
            expires_at_or_before=to_iso_z(utc_now()),
            limit=limit,
        )
        deleted = 0
        failed = 0
        for record in expired:
            try:
                self._remove_managed_capture(record, missing_ok=True)
                if self._web.assets.delete_staged(record.id):
                    deleted += 1
            except WebAnnotationAssetServiceError:
                failed += 1
        return {"scanned": len(expired), "deleted": deleted, "failed": failed}

    def _verify_capture(
        self,
        asset_id: str,
        *,
        expected: WebAnnotationAssetRegistration | WebAnnotationAssetRecord,
    ) -> ManagedCaptureManifest:
        directory = self._asset_directory(asset_id)
        manifest_path = directory / MANAGED_CAPTURE_MANIFEST
        capture_path = directory / MANAGED_CAPTURE_FILE
        try:
            raw_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest = ManagedCaptureManifest.model_validate(raw_manifest)
        except (OSError, UnicodeError, ValueError) as exc:
            raise _asset_conflict(asset_id, "manifest_invalid") from exc
        if manifest.asset_id != asset_id:
            raise _asset_conflict(asset_id, "manifest_mismatch")
        comparisons = {
            "mime_type": (manifest.mime_type, expected.mime_type),
            "width": (manifest.width, expected.width),
            "height": (manifest.height, expected.height),
            "byte_length": (
                manifest.byte_length,
                expected.byte_length
                if isinstance(expected, WebAnnotationAssetRegistration)
                else expected.size_bytes,
            ),
            "sha256": (manifest.sha256, expected.sha256),
        }
        if not isinstance(expected, WebAnnotationAssetRecord) or expected.state == "staged":
            comparisons["expires_at"] = (manifest.expires_at, expected.expires_at)
        if any(actual != wanted for actual, wanted in comparisons.values()):
            raise _asset_conflict(asset_id, "metadata_mismatch")
        try:
            size, digest, width, height = _capture_file_metadata(capture_path)
        except OSError as exc:
            raise _asset_conflict(asset_id, "file_missing") from exc
        if (
            size != manifest.byte_length
            or digest != manifest.sha256
            or width != manifest.width
            or height != manifest.height
        ):
            raise _asset_conflict(asset_id, "file_mismatch")
        return manifest

    def _remove_managed_capture(
        self,
        record: WebAnnotationAssetRecord,
        *,
        missing_ok: bool,
    ) -> None:
        expected_path = self._relative_capture_path(record.id)
        if record.storage_path != expected_path:
            raise _asset_conflict(record.id, "unmanaged_path")
        directory = self._asset_directory(record.id)
        if not directory.exists():
            if missing_ok:
                return
            raise _asset_conflict(record.id, "file_missing")
        try:
            raw_manifest = json.loads(
                (directory / MANAGED_CAPTURE_MANIFEST).read_text(encoding="utf-8")
            )
            manifest = ManagedCaptureManifest.model_validate(raw_manifest)
        except (OSError, UnicodeError, ValueError) as exc:
            raise _asset_conflict(record.id, "manifest_invalid") from exc
        if manifest.asset_id != record.id:
            raise _asset_conflict(record.id, "manifest_mismatch")
        try:
            shutil.rmtree(directory)
        except OSError as exc:
            raise _asset_conflict(record.id, "delete_failed") from exc

    def _asset_directory(self, asset_id: str) -> Path:
        if not _valid_asset_id(asset_id):
            raise _asset_conflict(asset_id, "invalid_id")
        candidate = (self._root / asset_id).resolve()
        if candidate.parent != self._root:
            raise _asset_conflict(asset_id, "unmanaged_path")
        return candidate

    @staticmethod
    def _relative_capture_path(asset_id: str) -> str:
        if not _valid_asset_id(asset_id):
            raise _asset_conflict(asset_id, "invalid_id")
        return f"browser/captures/staged/{asset_id}/{MANAGED_CAPTURE_FILE}"

    @staticmethod
    def _registration_matches(
        current: WebAnnotationAssetRecord,
        resource: WebAnnotationResourceRecord,
        asset: WebAnnotationAssetRegistration,
        storage_path: str,
    ) -> bool:
        return (
            current.state == "staged"
            and current.resource_id == resource.id
            and current.storage_path == storage_path
            and current.mime_type == asset.mime_type
            and current.size_bytes == asset.byte_length
            and current.sha256 == asset.sha256
            and current.width == asset.width
            and current.height == asset.height
            and current.expires_at == asset.expires_at
        )

    def _require_scope(self, scope: WebAnnotationScope) -> None:
        if scope.kind == "global":
            return
        scope_id = scope.id or ""
        if scope.kind == "session":
            exists = self._repositories.sessions.get(scope_id, include_internal=True) is not None
        else:
            exists = self._repositories.workspaces.get(scope_id) is not None
        if not exists:
            raise WebAnnotationAssetServiceError(
                "web_annotation_scope_forbidden",
                "The requested web annotation scope is unavailable",
                {"scope_kind": scope.kind, "scope_id": scope.id},
            )


class WebAnnotationAttachmentCloneService:
    def __init__(self, repositories: StorageRepositories, *, data_dir: Path) -> None:
        self._repositories = repositories
        self._web = repositories.web_annotations
        self._assets = WebAnnotationAssetService(repositories, data_dir=data_dir)
        self._attachments_root = (data_dir.resolve() / "attachments").resolve()

    def clone(
        self,
        *,
        annotation_id: str,
        asset_id: str,
        payload: WebAnnotationMessageAttachmentCloneRequest,
    ) -> WebAnnotationMessageAttachmentCloneResponse:
        target_directory: Path | None = None
        try:
            with self._repositories.db.transaction(immediate=True) as conn:
                session_row = conn.execute(
                    """
                    select id, user_id from sessions
                    where id = ? and archived_at is null
                    """,
                    (payload.session_id,),
                ).fetchone()
                if session_row is None:
                    raise WebAnnotationAssetServiceError(
                        "web_annotation_scope_forbidden",
                        "The target session is unavailable",
                        {"session_id": payload.session_id},
                    )

                existing = self._web.attachment_clones.get(
                    session_id=payload.session_id,
                    annotation_id=annotation_id,
                    asset_id=asset_id,
                    context_digest=payload.context_digest,
                    connection=conn,
                )
                if existing is not None:
                    attachment = self._repositories.attachments.get(
                        existing.attachment_id,
                        connection=conn,
                    )
                    if attachment is None:
                        raise _clone_unavailable(annotation_id, asset_id, "attachment_missing")
                    return _clone_response(
                        annotation_id=annotation_id,
                        asset_id=asset_id,
                        context_digest=payload.context_digest,
                        attachment=attachment,
                        reused=True,
                    )

                annotation = self._web.annotations.get(annotation_id, connection=conn)
                if annotation is None:
                    raise WebAnnotationAssetServiceError(
                        "web_annotation_not_found",
                        "Web annotation does not exist",
                        {"annotation_id": annotation_id},
                    )
                resource = self._web.resources.get(annotation.resource_id, connection=conn)
                if (
                    resource is None
                    or resource.scope.kind != "session"
                    or resource.scope.id != payload.session_id
                ):
                    raise WebAnnotationAssetServiceError(
                        "web_annotation_scope_forbidden",
                        "Web annotation evidence must belong to the target session",
                        {"annotation_id": annotation_id, "session_id": payload.session_id},
                    )
                if annotation.target.type != "region":
                    raise _asset_conflict(asset_id, "target_not_region")

                asset, source_path = self._assets.resolve_attached_capture(
                    annotation_id=annotation_id,
                    asset_id=asset_id,
                    resource_id=resource.id,
                    connection=conn,
                )
                attachment_id = new_id()
                suffix = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[
                    asset.mime_type
                ]
                name = f"web-annotation-{asset.id.removeprefix('web-capture-')}{suffix}"
                target_directory = (self._attachments_root / attachment_id).resolve()
                if target_directory.parent != self._attachments_root:
                    raise _clone_unavailable(annotation_id, asset_id, "unmanaged_target")
                target_path = target_directory / name
                target_directory.mkdir(parents=True, exist_ok=False)
                try:
                    shutil.copyfile(source_path, target_path)
                    (
                        copied_size,
                        copied_digest,
                        copied_width,
                        copied_height,
                    ) = _capture_file_metadata(
                        target_path,
                    )
                except OSError as exc:
                    raise _clone_unavailable(annotation_id, asset_id, "copy_failed") from exc
                if (
                    copied_size != asset.size_bytes
                    or copied_digest != asset.sha256
                    or copied_width != asset.width
                    or copied_height != asset.height
                ):
                    raise _clone_unavailable(annotation_id, asset_id, "copy_mismatch")

                attachment = self._repositories.attachments.create(
                    attachment_id=attachment_id,
                    session_id=payload.session_id,
                    user_id=str(session_row["user_id"]),
                    type="image",
                    source="web_annotation",
                    name=name,
                    path=str(target_path),
                    mime_type=asset.mime_type,
                    size=asset.size_bytes,
                    connection=conn,
                )
                self._web.attachment_clones.create(
                    session_id=payload.session_id,
                    annotation_id=annotation_id,
                    asset_id=asset_id,
                    context_digest=payload.context_digest,
                    attachment_id=attachment.id,
                    connection=conn,
                )
            logger.debug(
                "[WebAnnotations] 区域证据已复制为会话附件 | "
                f"annotation_id={annotation_id} | asset_id={asset_id} | "
                f"attachment_id={attachment.id} | size={attachment.size}"
            )
            return _clone_response(
                annotation_id=annotation_id,
                asset_id=asset_id,
                context_digest=payload.context_digest,
                attachment=attachment,
                reused=False,
            )
        except Exception:
            if target_directory is not None:
                shutil.rmtree(target_directory, ignore_errors=True)
            raise


def _clone_response(
    *,
    annotation_id: str,
    asset_id: str,
    context_digest: str,
    attachment: AttachmentRecord,
    reused: bool,
) -> WebAnnotationMessageAttachmentCloneResponse:
    if attachment.session_id is None:
        raise _clone_unavailable(annotation_id, asset_id, "attachment_scope_missing")
    return WebAnnotationMessageAttachmentCloneResponse(
        annotation_id=annotation_id,
        asset_id=asset_id,
        context_digest=context_digest,
        reused=reused,
        attachment=WebAnnotationMessageAttachmentRecord(
            id=attachment.id,
            attachment_id=attachment.id,
            session_id=attachment.session_id,
            user_id=attachment.user_id,
            type="image",
            source="web_annotation",
            name=attachment.name,
            path=attachment.path,
            mime_type=attachment.mime_type,
            size=attachment.size,
            created_at=attachment.created_at,
            updated_at=attachment.updated_at,
        ),
    )


def _clone_unavailable(
    annotation_id: str,
    asset_id: str,
    reason: str,
) -> WebAnnotationAssetServiceError:
    return WebAnnotationAssetServiceError(
        "web_annotation_asset_unavailable",
        "Web annotation evidence could not be copied into session history",
        {"annotation_id": annotation_id, "asset_id": asset_id, "reason": reason},
    )


def _valid_asset_id(asset_id: str) -> bool:
    prefix = "web-capture-"
    suffix = asset_id.removeprefix(prefix)
    return (
        asset_id.startswith(prefix)
        and len(suffix) == 32
        and all(character in "0123456789abcdef" for character in suffix)
    )


def _capture_file_metadata(path: Path) -> tuple[int, str, int, int]:
    size = path.stat().st_size
    if size <= 0 or size > MAX_MANAGED_CAPTURE_BYTES:
        raise OSError("managed capture size is invalid")
    digest = hashlib.sha256()
    header = b""
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            if len(header) < 24:
                header += chunk[: 24 - len(header)]
            digest.update(chunk)
    if len(header) < 24 or header[:8] != PNG_SIGNATURE or header[12:16] != b"IHDR":
        raise OSError("managed capture is not a PNG")
    width, height = struct.unpack(">II", header[16:24])
    if width <= 0 or height <= 0:
        raise OSError("managed capture dimensions are invalid")
    return size, digest.hexdigest(), width, height


def _parse_timestamp(value: str, field_name: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{field_name} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{field_name} must include a timezone")
    return parsed.astimezone(UTC)


def _asset_conflict(asset_id: str, state: str) -> WebAnnotationAssetServiceError:
    return WebAnnotationAssetServiceError(
        "web_annotation_asset_state_conflict",
        "Web annotation asset is unavailable or no longer staged",
        {"asset_id": asset_id, "state": state},
    )


__all__ = [
    "ManagedCaptureManifest",
    "WebAnnotationAssetRegistration",
    "WebAnnotationAssetRegistrationRequest",
    "WebAnnotationAssetService",
    "WebAnnotationAssetServiceError",
    "WebAnnotationAttachmentCloneService",
]
