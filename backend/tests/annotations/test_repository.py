from __future__ import annotations

from backend.app.annotations.models import DocumentAnnotationTarget, TextAnnotationTarget
from backend.app.annotations.repository import WorkspaceAnnotationsRepository
from backend.app.storage import init_database

from .test_models import text_selector


def _repository(tmp_path) -> tuple[WorkspaceAnnotationsRepository, object]:
    db = init_database(tmp_path / "app.db")
    with db.connect() as conn:
        conn.executemany(
            """
            insert into workspaces (
              id, name, root_path, normalized_root_path, created_at, updated_at
            ) values (?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "workspace-1",
                    "Workspace One",
                    "/tmp/workspace-1",
                    "/tmp/workspace-1",
                    "2026-07-11T00:00:00Z",
                    "2026-07-11T00:00:00Z",
                ),
                (
                    "workspace-2",
                    "Workspace Two",
                    "/tmp/workspace-2",
                    "/tmp/workspace-2",
                    "2026-07-11T00:00:00Z",
                    "2026-07-11T00:00:00Z",
                ),
            ],
        )
    return WorkspaceAnnotationsRepository(db), db


def _text_target() -> TextAnnotationTarget:
    return TextAnnotationTarget.model_validate({"type": "text", "selector": text_selector()})


def test_repository_crud_keeps_body_and_target_updates_separate(tmp_path) -> None:
    repository, _db = _repository(tmp_path)
    document_target = DocumentAnnotationTarget(type="document")
    repository.create(
        annotation_id="ann-1",
        workspace_id="workspace-1",
        document_path="docs/design.md",
        target=document_target,
        body="Whole file",
    )

    body_updated = repository.update_body(
        "ann-1",
        workspace_id="workspace-1",
        body="Updated body",
    )
    assert body_updated is not None
    assert body_updated.body == "Updated body"
    assert isinstance(body_updated.target, DocumentAnnotationTarget)

    target_updated = repository.replace_target(
        "ann-1",
        workspace_id="workspace-1",
        target=_text_target(),
    )
    assert target_updated is not None
    assert target_updated.body == "Updated body"
    assert isinstance(target_updated.target, TextAnnotationTarget)
    assert target_updated.target.selector.quote.exact == "text"

    assert repository.delete("ann-1", workspace_id="workspace-1") is True
    assert repository.get("ann-1", workspace_id="workspace-1") is None
    assert repository.delete("ann-1", workspace_id="workspace-1") is False


def test_repository_list_is_stable_and_isolated_by_workspace_and_path(tmp_path) -> None:
    repository, _db = _repository(tmp_path)
    for annotation_id, workspace_id, document_path in [
        ("ann-b", "workspace-1", "docs/design.md"),
        ("ann-a", "workspace-1", "docs/design.md"),
        ("ann-other-path", "workspace-1", "README.md"),
        ("ann-other-workspace", "workspace-2", "docs/design.md"),
    ]:
        repository.create(
            annotation_id=annotation_id,
            workspace_id=workspace_id,
            document_path=document_path,
            target=DocumentAnnotationTarget(type="document"),
            body=annotation_id,
        )

    listed = repository.list(workspace_id="workspace-1", document_path="docs/design.md")

    assert [record.id for record in listed] == ["ann-b", "ann-a"]
    assert repository.get("ann-other-workspace", workspace_id="workspace-1") is None


def test_repository_delete_is_a_hard_delete(tmp_path) -> None:
    repository, db = _repository(tmp_path)
    repository.create(
        annotation_id="ann-hard-delete",
        workspace_id="workspace-1",
        document_path="README.md",
        target=DocumentAnnotationTarget(type="document"),
        body="Delete me",
    )

    assert repository.delete("ann-hard-delete", workspace_id="workspace-1") is True

    with db.connect() as conn:
        row = conn.execute(
            "select * from workspace_annotations where id = 'ann-hard-delete'"
        ).fetchone()
    assert row is None
