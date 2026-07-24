from __future__ import annotations

from typing import Annotated, Any, TypeVar

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Response, status
from pydantic import BaseModel, ValidationError

from backend.app.api.dependencies import get_app_settings, get_repositories
from backend.app.core.config import AppSettings
from backend.app.storage import StorageRepositories
from backend.app.web_annotations.assets import (
    WebAnnotationAssetRegistrationRequest,
    WebAnnotationAssetService,
    WebAnnotationAssetServiceError,
    WebAnnotationAttachmentCloneService,
)
from backend.app.web_annotations.models import (
    WebAnnotationAssetRecord,
    WebAnnotationCreateRequest,
    WebAnnotationDetail,
    WebAnnotationMessageAttachmentCloneRequest,
    WebAnnotationMessageAttachmentCloneResponse,
    WebAnnotationPage,
    WebAnnotationPatchRequest,
    WebAnnotationRetargetRequest,
    WebAnnotationScope,
    WebAnnotationScopeKind,
    WebAnnotationSourceKind,
)
from backend.app.web_annotations.service import WebAnnotationService, WebAnnotationServiceError

router = APIRouter(prefix="/api/web-annotations", tags=["web-annotations"])
RepositoriesDep = Depends(get_repositories)
SettingsDep = Depends(get_app_settings)
PayloadT = TypeVar("PayloadT", bound=BaseModel)


@router.get("", response_model=WebAnnotationPage)
async def list_web_annotations(
    scope_kind: WebAnnotationScopeKind,
    scope_id: str | None = None,
    source_kind: WebAnnotationSourceKind = "web",
    url: str | None = None,
    document_url: str | None = None,
    cursor: str | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> WebAnnotationPage:
    scope = _parse_model(WebAnnotationScope, {"kind": scope_kind, "id": scope_id})
    return _call(
        _service(repositories, settings).list,
        scope=scope,
        source_kind=source_kind,
        url=url,
        document_url=document_url,
        cursor=cursor,
        limit=limit,
    )


@router.post(
    "/assets", response_model=WebAnnotationAssetRecord, status_code=status.HTTP_201_CREATED
)
async def register_web_annotation_asset(
    payload: Annotated[Any, Body()],
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> WebAnnotationAssetRecord:
    parsed = _parse_model(WebAnnotationAssetRegistrationRequest, payload)
    return _call(_asset_service(repositories, settings).register, parsed)


@router.delete("/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_web_annotation_asset(
    asset_id: str,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> Response:
    _call(_asset_service(repositories, settings).delete_staged, asset_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{annotation_id}/evidence/{asset_id}/message-attachment",
    response_model=WebAnnotationMessageAttachmentCloneResponse,
)
async def clone_web_annotation_evidence_to_message_attachment(
    annotation_id: str,
    asset_id: str,
    payload: Annotated[Any, Body()],
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> WebAnnotationMessageAttachmentCloneResponse:
    parsed = _parse_model(WebAnnotationMessageAttachmentCloneRequest, payload)
    return _call(
        _attachment_clone_service(repositories, settings).clone,
        annotation_id=annotation_id,
        asset_id=asset_id,
        payload=parsed,
    )


@router.post("", response_model=WebAnnotationDetail, status_code=status.HTTP_201_CREATED)
async def create_web_annotation(
    payload: Annotated[Any, Body()],
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> WebAnnotationDetail:
    parsed = _parse_model(WebAnnotationCreateRequest, payload)
    return _call(_service(repositories, settings).create, parsed)


@router.get("/{annotation_id}", response_model=WebAnnotationDetail)
async def get_web_annotation(
    annotation_id: str,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> WebAnnotationDetail:
    return _call(_service(repositories, settings).get, annotation_id)


@router.patch("/{annotation_id}", response_model=WebAnnotationDetail)
async def patch_web_annotation(
    annotation_id: str,
    payload: Annotated[Any, Body()],
    repositories: StorageRepositories = RepositoriesDep,
    if_match: Annotated[str | None, Header(alias="If-Match")] = None,
    settings: AppSettings = SettingsDep,
) -> WebAnnotationDetail:
    parsed = _parse_model(WebAnnotationPatchRequest, payload)
    _require_if_match(if_match, parsed.expected_revision)
    return _call(_service(repositories, settings).patch, annotation_id, parsed)


@router.put("/{annotation_id}/target", response_model=WebAnnotationDetail)
async def retarget_web_annotation(
    annotation_id: str,
    payload: Annotated[Any, Body()],
    repositories: StorageRepositories = RepositoriesDep,
    if_match: Annotated[str | None, Header(alias="If-Match")] = None,
    settings: AppSettings = SettingsDep,
) -> WebAnnotationDetail:
    parsed = _parse_model(WebAnnotationRetargetRequest, payload)
    _require_if_match(if_match, parsed.expected_revision)
    return _call(_service(repositories, settings).retarget, annotation_id, parsed)


@router.delete("/{annotation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_web_annotation(
    annotation_id: str,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> Response:
    _call(_service(repositories, settings).delete, annotation_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _service(repositories: StorageRepositories, settings: AppSettings) -> WebAnnotationService:
    return WebAnnotationService(repositories, data_dir=settings.data_dir)


def _asset_service(
    repositories: StorageRepositories,
    settings: AppSettings,
) -> WebAnnotationAssetService:
    return WebAnnotationAssetService(repositories, data_dir=settings.data_dir)


def _attachment_clone_service(
    repositories: StorageRepositories,
    settings: AppSettings,
) -> WebAnnotationAttachmentCloneService:
    return WebAnnotationAttachmentCloneService(repositories, data_dir=settings.data_dir)


def _parse_model(model_type: type[PayloadT], payload: Any) -> PayloadT:
    try:
        return model_type.model_validate(payload)
    except ValidationError as exc:
        raise _validation_http_error(exc) from exc


def _validation_http_error(exc: ValidationError) -> HTTPException:
    errors = [
        {
            "location": [str(item) for item in error.get("loc", ())],
            "type": str(error.get("type", "value_error")),
            "message": str(error.get("msg", "Invalid value")),
        }
        for error in exc.errors(include_url=False)
    ]
    messages = " ".join(error["message"] for error in errors).lower()
    locations = [error["location"] for error in errors]
    if any(location and location[0] == "schema_version" for location in locations):
        code = "web_annotation_schema_unsupported"
        http_status = status.HTTP_422_UNPROCESSABLE_CONTENT
    elif "cannot exceed" in messages or any(error["type"] == "too_long" for error in errors):
        code = "web_annotation_payload_too_large"
        http_status = status.HTTP_413_CONTENT_TOO_LARGE
    elif any(
        location[:2] in (["source", "url"], ["source", "canonical_url"]) for location in locations
    ):
        code = "web_annotation_invalid_url"
        http_status = status.HTTP_400_BAD_REQUEST
    elif any(location and location[0] == "target" for location in locations):
        code = "web_annotation_target_invalid"
        http_status = status.HTTP_400_BAD_REQUEST
    else:
        code = "web_annotation_request_invalid"
        http_status = status.HTTP_400_BAD_REQUEST
    return HTTPException(
        status_code=http_status,
        detail={
            "code": code,
            "message": "Web annotation request validation failed",
            "details": {"errors": errors},
        },
    )


def _call(operation, *args, **kwargs):
    try:
        return operation(*args, **kwargs)
    except (WebAnnotationServiceError, WebAnnotationAssetServiceError) as exc:
        raise HTTPException(
            status_code=_error_status(exc.code),
            detail={"code": exc.code, "message": exc.message, "details": exc.details},
        ) from exc


def _error_status(code: str) -> int:
    if code == "web_annotation_not_found":
        return status.HTTP_404_NOT_FOUND
    if code == "web_annotation_asset_not_found":
        return status.HTTP_404_NOT_FOUND
    if code == "web_annotation_scope_forbidden":
        return status.HTTP_403_FORBIDDEN
    if code in {
        "web_annotation_revision_conflict",
        "web_annotation_incognito_persistence_forbidden",
        "web_annotation_asset_state_conflict",
    }:
        return status.HTTP_409_CONFLICT
    if code == "web_annotation_payload_too_large":
        return status.HTTP_413_CONTENT_TOO_LARGE
    if code == "web_annotation_schema_unsupported":
        return status.HTTP_422_UNPROCESSABLE_CONTENT
    if code == "web_annotation_asset_unavailable":
        return status.HTTP_503_SERVICE_UNAVAILABLE
    return status.HTTP_400_BAD_REQUEST


def _require_if_match(if_match: str | None, expected_revision: int) -> None:
    if if_match is None:
        return
    normalized = if_match.strip()
    if normalized.startswith("W/"):
        normalized = normalized[2:].strip()
    normalized = normalized.strip('"')
    if not normalized.isdigit() or int(normalized) != expected_revision:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "web_annotation_request_invalid",
                "message": "If-Match does not match expected_revision",
                "details": {"if_match": if_match, "expected_revision": expected_revision},
            },
        )


__all__ = ["router"]
