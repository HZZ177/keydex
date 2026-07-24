from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

from backend.app.storage import StorageRepositories
from backend.app.web_annotations.assets import WebAnnotationAssetService
from backend.app.web_annotations.models import (
    WebAnnotationCreateRequest,
    WebAnnotationDetail,
    WebAnnotationItem,
    WebAnnotationPage,
    WebAnnotationPatchRequest,
    WebAnnotationResourceRecord,
    WebAnnotationRetargetRequest,
    WebAnnotationScope,
    WebAnnotationSourceKind,
    validate_properties_source_kind,
    validate_target_source_kind,
)
from backend.app.web_annotations.repository import WebAnnotationRevisionConflict
from backend.app.web_annotations.url_identity import (
    WebUrlIdentityError,
    normalize_annotation_url,
)


class WebAnnotationServiceError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


class WebAnnotationService:
    def __init__(self, repositories: StorageRepositories, *, data_dir: Path) -> None:
        self._repositories = repositories
        self._web = repositories.web_annotations
        self._assets = WebAnnotationAssetService(repositories, data_dir=data_dir)

    def list(
        self,
        *,
        scope: WebAnnotationScope,
        url: str | None,
        document_url: str | None,
        cursor: str | None,
        limit: int,
        source_kind: WebAnnotationSourceKind = "web",
    ) -> WebAnnotationPage:
        self._require_scope(scope)
        if (url is None) == (document_url is None):
            raise WebAnnotationServiceError(
                "web_annotation_request_invalid",
                "Exactly one of url or document_url is required",
            )
        try:
            if url is not None:
                identity = normalize_annotation_url(url, source_kind=source_kind)
                resource = self._web.resources.find_by_identity(
                    scope=scope,
                    source_kind=source_kind,
                    url_key=identity.url_key,
                )
                resources = [resource] if resource is not None else []
            else:
                normalized_document = normalize_annotation_url(
                    document_url or "",
                    source_kind=source_kind,
                ).document_url
                resources = self._web.resources.list_by_document(
                    scope=scope,
                    source_kind=source_kind,
                    document_url=normalized_document,
                )
        except WebUrlIdentityError as exc:
            raise WebAnnotationServiceError(
                exc.code,
                str(exc),
                {"url": url or document_url},
            ) from exc

        before = _decode_cursor(cursor)
        records, has_more = self._web.annotations.list_page(
            resource_ids=[resource.id for resource in resources],
            limit=limit,
            before=before,
        )
        resource_by_id = {resource.id: resource for resource in resources}
        items = [
            WebAnnotationItem(
                resource=resource_by_id[record.resource_id],
                annotation=record,
            )
            for record in records
        ]
        next_cursor = _encode_cursor(records[-1].updated_at, records[-1].id) if has_more else None
        return WebAnnotationPage(items=items, next_cursor=next_cursor)

    def create(self, payload: WebAnnotationCreateRequest) -> WebAnnotationDetail:
        self._require_scope(payload.scope)
        if payload.source.profile_mode == "incognito":
            raise WebAnnotationServiceError(
                "web_annotation_incognito_persistence_forbidden",
                "Incognito pages cannot persist web annotations",
            )
        if payload.target.type == "region" and not payload.staged_asset_ids:
            raise WebAnnotationServiceError(
                "web_annotation_asset_state_conflict",
                "Region annotations require staged capture evidence",
            )
        if payload.target.type != "region" and payload.staged_asset_ids:
            raise WebAnnotationServiceError(
                "web_annotation_asset_state_conflict",
                "Only region annotations can attach capture evidence",
                {"staged_asset_ids": payload.staged_asset_ids},
            )
        with self._repositories.db.transaction(immediate=True) as conn:
            resource = self._web.resources.upsert(
                scope=payload.scope,
                identity=payload.source.identity(),
                title=payload.source.title,
                canonical_url=payload.source.canonical_url,
                connection=conn,
            )
            staged_assets = self._assets.require_for_attach(
                asset_ids=payload.staged_asset_ids,
                resource=resource,
                connection=conn,
            )
            annotation = self._web.annotations.create(
                resource_id=resource.id,
                target=payload.target,
                body_markdown=payload.body_markdown,
                tags=payload.tags,
                properties=payload.properties,
                connection=conn,
            )
            assets = self._assets.attach(
                records=staged_assets,
                annotation_id=annotation.id,
                resource_id=resource.id,
                connection=conn,
            )
        return WebAnnotationDetail(resource=resource, annotation=annotation, assets=assets)

    def get(self, annotation_id: str) -> WebAnnotationDetail:
        annotation = self._web.annotations.get(annotation_id)
        if annotation is None:
            raise _not_found(annotation_id)
        resource = self._require_resource(annotation.resource_id)
        self._require_scope(resource.scope)
        history = self._web.target_history.list_by_annotation(annotation.id)
        assets = self._web.assets.list_by_annotation(annotation.id)
        return WebAnnotationDetail(
            resource=resource,
            annotation=annotation,
            target_history=history,
            assets=assets,
        )

    def patch(
        self,
        annotation_id: str,
        payload: WebAnnotationPatchRequest,
    ) -> WebAnnotationDetail:
        current = self.get(annotation_id)
        if payload.properties is not None:
            try:
                validate_properties_source_kind(
                    payload.properties,
                    current.resource.source_kind,
                )
            except ValueError as exc:
                raise WebAnnotationServiceError(
                    "web_annotation_request_invalid",
                    str(exc),
                ) from exc
        try:
            updated = self._web.annotations.patch(
                annotation_id,
                expected_revision=payload.expected_revision,
                body_markdown=payload.body_markdown,
                tags=payload.tags,
                properties=payload.properties,
            )
        except WebAnnotationRevisionConflict as exc:
            raise self._revision_conflict(payload.expected_revision, current.resource, exc) from exc
        if updated is None:
            raise _not_found(annotation_id)
        return WebAnnotationDetail(
            resource=current.resource,
            annotation=updated,
            target_history=current.target_history,
            assets=current.assets,
        )

    def retarget(
        self,
        annotation_id: str,
        payload: WebAnnotationRetargetRequest,
    ) -> WebAnnotationDetail:
        current = self.get(annotation_id)
        try:
            validate_target_source_kind(
                payload.target,
                current.resource.source_kind,
            )
        except ValueError as exc:
            raise WebAnnotationServiceError(
                "web_annotation_target_invalid",
                str(exc),
            ) from exc
        if payload.target.type == "region" and not payload.staged_asset_ids:
            raise WebAnnotationServiceError(
                "web_annotation_asset_state_conflict",
                "Region retargets require new staged capture evidence",
            )
        if payload.target.type != "region" and payload.staged_asset_ids:
            raise WebAnnotationServiceError(
                "web_annotation_asset_state_conflict",
                "Only region retargets can attach capture evidence",
                {"staged_asset_ids": payload.staged_asset_ids},
            )
        try:
            with self._repositories.db.transaction(immediate=True) as conn:
                staged_assets = self._assets.require_for_attach(
                    asset_ids=payload.staged_asset_ids,
                    resource=current.resource,
                    connection=conn,
                )
                updated = self._web.annotations.replace_target_with_history(
                    annotation_id,
                    expected_revision=payload.expected_revision,
                    target=payload.target,
                    reason=payload.reason,
                    connection=conn,
                )
                if updated is None:
                    raise _not_found(annotation_id)
                self._assets.attach(
                    records=staged_assets,
                    annotation_id=annotation_id,
                    resource_id=current.resource.id,
                    connection=conn,
                )
        except WebAnnotationRevisionConflict as exc:
            raise self._revision_conflict(payload.expected_revision, current.resource, exc) from exc
        history = self._web.target_history.list_by_annotation(annotation_id)
        assets = self._web.assets.list_by_annotation(annotation_id)
        return WebAnnotationDetail(
            resource=current.resource,
            annotation=updated,
            target_history=history,
            assets=assets,
        )

    def delete(self, annotation_id: str) -> None:
        self.get(annotation_id)
        self._assets.remove_annotation_assets(annotation_id)
        if not self._web.annotations.delete(annotation_id):
            raise _not_found(annotation_id)

    def _require_resource(self, resource_id: str) -> WebAnnotationResourceRecord:
        resource = self._web.resources.get(resource_id)
        if resource is None:
            raise WebAnnotationServiceError(
                "web_annotation_not_found",
                "Web annotation resource does not exist",
                {"resource_id": resource_id},
            )
        return resource

    def _require_scope(self, scope: WebAnnotationScope) -> None:
        if scope.kind == "global":
            return
        scope_id = scope.id or ""
        if scope.kind == "session":
            exists = self._repositories.sessions.get(scope_id, include_internal=True) is not None
        else:
            exists = self._repositories.workspaces.get(scope_id) is not None
        if not exists:
            raise WebAnnotationServiceError(
                "web_annotation_scope_forbidden",
                "The requested web annotation scope is unavailable",
                {"scope_kind": scope.kind, "scope_id": scope.id},
            )

    @staticmethod
    def _revision_conflict(
        expected_revision: int,
        resource: WebAnnotationResourceRecord,
        conflict: WebAnnotationRevisionConflict,
    ) -> WebAnnotationServiceError:
        current = WebAnnotationItem(resource=resource, annotation=conflict.current)
        return WebAnnotationServiceError(
            "web_annotation_revision_conflict",
            "Web annotation changed after it was loaded",
            {
                "expected_revision": expected_revision,
                "current": current.model_dump(mode="json"),
            },
        )


def _not_found(annotation_id: str) -> WebAnnotationServiceError:
    return WebAnnotationServiceError(
        "web_annotation_not_found",
        "Web annotation does not exist",
        {"annotation_id": annotation_id},
    )


def _encode_cursor(updated_at: str, annotation_id: str) -> str:
    payload = json.dumps([updated_at, annotation_id], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str | None) -> tuple[str, str] | None:
    if cursor is None:
        return None
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode())
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WebAnnotationServiceError(
            "web_annotation_request_invalid",
            "Web annotation cursor is invalid",
        ) from exc
    if (
        not isinstance(payload, list)
        or len(payload) != 2
        or not all(isinstance(item, str) and item for item in payload)
    ):
        raise WebAnnotationServiceError(
            "web_annotation_request_invalid",
            "Web annotation cursor is invalid",
        )
    return payload[0], payload[1]


__all__ = ["WebAnnotationService", "WebAnnotationServiceError"]
