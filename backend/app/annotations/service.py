from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.app.annotations.models import (
    AnnotationCreateRequest,
    AnnotationRecord,
    TextAnnotationTarget,
)
from backend.app.annotations.repository import WorkspaceAnnotationsRepository
from backend.app.security import WorkspacePathError, resolve_workspace_path
from backend.app.services.workspace_service import WorkspaceService, WorkspaceServiceError


class AnnotationServiceError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


@dataclass(frozen=True)
class AnnotationDocument:
    workspace_id: str
    path: str
    absolute_path: Path
    revision: str


class AnnotationService:
    def __init__(self, workspaces_repository, annotations_repository) -> None:
        self._workspaces = workspaces_repository
        self._annotations: WorkspaceAnnotationsRepository = annotations_repository

    def list(self, *, workspace_id: str, path: str) -> list[AnnotationRecord]:
        document = self.require_document(workspace_id=workspace_id, path=path)
        return self._annotations.list(
            workspace_id=workspace_id,
            document_path=document.path,
        )

    def create(
        self,
        *,
        workspace_id: str,
        payload: AnnotationCreateRequest,
    ) -> AnnotationRecord:
        document = self.require_document(workspace_id=workspace_id, path=payload.path)
        if isinstance(payload.target, TextAnnotationTarget):
            self._require_revision(payload.target.selector.document_revision, document)
        return self._annotations.create(
            workspace_id=workspace_id,
            document_path=document.path,
            target=payload.target,
            body=payload.body,
        )

    def update_body(
        self,
        annotation_id: str,
        *,
        workspace_id: str,
        body: str,
    ) -> AnnotationRecord:
        self._require_workspace(workspace_id)
        updated = self._annotations.update_body(
            annotation_id,
            workspace_id=workspace_id,
            body=body,
        )
        if updated is None:
            raise self._not_found(annotation_id, workspace_id)
        return updated

    def replace_target(
        self,
        annotation_id: str,
        *,
        workspace_id: str,
        target: TextAnnotationTarget,
    ) -> AnnotationRecord:
        existing = self.require_annotation(annotation_id, workspace_id=workspace_id)
        document = self.require_document(
            workspace_id=workspace_id,
            path=existing.document_path,
        )
        self._require_revision(target.selector.document_revision, document)
        updated = self._annotations.replace_target(
            annotation_id,
            workspace_id=workspace_id,
            target=target,
        )
        if updated is None:
            raise self._not_found(annotation_id, workspace_id)
        return updated

    def delete(self, annotation_id: str, *, workspace_id: str) -> None:
        self._require_workspace(workspace_id)
        if not self._annotations.delete(annotation_id, workspace_id=workspace_id):
            raise self._not_found(annotation_id, workspace_id)

    def require_annotation(
        self,
        annotation_id: str,
        *,
        workspace_id: str,
    ) -> AnnotationRecord:
        self._require_workspace(workspace_id)
        record = self._annotations.get(annotation_id, workspace_id=workspace_id)
        if record is None:
            raise self._not_found(annotation_id, workspace_id)
        return record

    def require_document(self, *, workspace_id: str, path: str) -> AnnotationDocument:
        workspace = self._require_workspace(workspace_id)
        normalized_path = _normalize_document_path(path)
        root = Path(workspace.root_path).expanduser().resolve()
        try:
            target = resolve_workspace_path(
                normalized_path,
                cwd=root,
                workspace_roots=[root],
            )
        except WorkspacePathError as exc:
            raise AnnotationServiceError(
                "annotation_path_forbidden",
                str(exc),
                {"workspace_id": workspace_id, "path": path},
            ) from exc
        if not target.exists():
            raise AnnotationServiceError(
                "annotation_path_not_found",
                f"Annotation document does not exist: {normalized_path}",
                {"workspace_id": workspace_id, "path": normalized_path},
            )
        if not target.is_file():
            raise AnnotationServiceError(
                "annotation_path_not_file",
                f"Annotation document is not a file: {normalized_path}",
                {"workspace_id": workspace_id, "path": normalized_path},
            )
        return AnnotationDocument(
            workspace_id=workspace_id,
            path=target.relative_to(root).as_posix(),
            absolute_path=target,
            revision=document_revision(target),
        )

    def _require_workspace(self, workspace_id: str):
        try:
            return WorkspaceService(self._workspaces).require_workspace(workspace_id)
        except WorkspaceServiceError as exc:
            raise AnnotationServiceError(exc.code, exc.message, exc.details) from exc

    @staticmethod
    def _require_revision(expected: str, document: AnnotationDocument) -> None:
        if expected != document.revision:
            raise AnnotationServiceError(
                "annotation_document_changed",
                "The annotation document changed after the selection was created",
                {
                    "workspace_id": document.workspace_id,
                    "path": document.path,
                    "expected_revision": expected,
                    "current_revision": document.revision,
                },
            )

    @staticmethod
    def _not_found(annotation_id: str, workspace_id: str) -> AnnotationServiceError:
        return AnnotationServiceError(
            "annotation_not_found",
            "Annotation does not exist in the current workspace",
            {"annotation_id": annotation_id, "workspace_id": workspace_id},
        )


def document_revision(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def document_revision_bytes(content: bytes) -> str:
    return f"sha256:{hashlib.sha256(content).hexdigest()}"


def _normalize_document_path(path: str) -> str:
    raw = str(path or "").strip()
    if not raw or raw == ".":
        raise AnnotationServiceError("annotation_path_empty", "Annotation path cannot be empty")
    candidate = Path(raw)
    if candidate.is_absolute():
        raise AnnotationServiceError(
            "annotation_path_absolute",
            "Annotation path must be workspace-relative",
            {"path": raw},
        )
    normalized = raw.replace("\\", "/").strip("/")
    if not normalized or any(segment == ".." for segment in normalized.split("/")):
        raise AnnotationServiceError(
            "annotation_path_forbidden",
            "Annotation path must stay inside the workspace",
            {"path": raw},
        )
    return "/".join(segment for segment in normalized.split("/") if segment and segment != ".")
