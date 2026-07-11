from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.annotations.models import AnnotationCreateRequest, DocumentAnnotationTarget
from backend.app.annotations.repository import WorkspaceAnnotationsRepository
from backend.app.annotations.service import (
    AnnotationService,
    AnnotationServiceError,
    document_revision,
)
from backend.app.storage import init_database
from backend.app.storage.repositories import WorkspacesRepository

from .test_models import text_selector


def _service(tmp_path) -> tuple[AnnotationService, Path]:
    root = tmp_path / "workspace"
    root.mkdir()
    db = init_database(tmp_path / "app.db")
    workspaces = WorkspacesRepository(db)
    workspaces.create(workspace_id="workspace-1", root_path=root)
    return AnnotationService(workspaces, WorkspaceAnnotationsRepository(db)), root


def _text_create_payload(path: str, revision: str) -> AnnotationCreateRequest:
    selector = text_selector()
    selector["documentRevision"] = revision
    return AnnotationCreateRequest.model_validate(
        {
            "path": path,
            "body": "Review this text",
            "target": {"type": "text", "selector": selector},
        }
    )


def test_service_normalizes_paths_and_validates_document_revision(tmp_path) -> None:
    service, root = _service(tmp_path)
    document = root / "docs" / "design.md"
    document.parent.mkdir()
    document.write_text("Design text", encoding="utf-8")
    revision = document_revision(document)

    created = service.create(
        workspace_id="workspace-1",
        payload=_text_create_payload("docs\\design.md", revision),
    )

    assert created.document_path == "docs/design.md"
    assert service.list(workspace_id="workspace-1", path="docs/design.md") == [created]


def test_service_rejects_changed_documents_without_writing(tmp_path) -> None:
    service, root = _service(tmp_path)
    document = root / "README.md"
    document.write_text("Before", encoding="utf-8")
    payload = _text_create_payload("README.md", document_revision(document))
    document.write_text("After", encoding="utf-8")

    with pytest.raises(AnnotationServiceError) as exc_info:
        service.create(workspace_id="workspace-1", payload=payload)

    assert exc_info.value.code == "annotation_document_changed"
    assert service.list(workspace_id="workspace-1", path="README.md") == []


@pytest.mark.parametrize(
    ("path", "expected_code"),
    [
        ("", "annotation_path_empty"),
        (".", "annotation_path_empty"),
        ("../outside.md", "annotation_path_forbidden"),
        ("missing.md", "annotation_path_not_found"),
    ],
)
def test_service_rejects_invalid_document_paths(tmp_path, path: str, expected_code: str) -> None:
    service, _root = _service(tmp_path)

    with pytest.raises(AnnotationServiceError) as exc_info:
        service.list(workspace_id="workspace-1", path=path)

    assert exc_info.value.code == expected_code


def test_service_rejects_absolute_paths_and_directories(tmp_path) -> None:
    service, root = _service(tmp_path)
    directory = root / "docs"
    directory.mkdir()

    with pytest.raises(AnnotationServiceError) as absolute_error:
        service.list(workspace_id="workspace-1", path=str(directory.resolve()))
    with pytest.raises(AnnotationServiceError) as directory_error:
        service.list(workspace_id="workspace-1", path="docs")

    assert absolute_error.value.code == "annotation_path_absolute"
    assert directory_error.value.code == "annotation_path_not_file"


def test_body_update_and_delete_do_not_require_the_document_to_still_exist(tmp_path) -> None:
    service, root = _service(tmp_path)
    document = root / "README.md"
    document.write_text("Content", encoding="utf-8")
    created = service.create(
        workspace_id="workspace-1",
        payload=AnnotationCreateRequest(
            path="README.md",
            body="Whole file",
            target=DocumentAnnotationTarget(type="document"),
        ),
    )
    document.unlink()

    updated = service.update_body(
        created.id,
        workspace_id="workspace-1",
        body="Updated",
    )
    service.delete(created.id, workspace_id="workspace-1")

    assert updated.body == "Updated"
    with pytest.raises(AnnotationServiceError) as exc_info:
        service.require_annotation(created.id, workspace_id="workspace-1")
    assert exc_info.value.code == "annotation_not_found"
