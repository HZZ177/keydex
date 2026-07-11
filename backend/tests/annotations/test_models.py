from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.app.annotations.models import (
    AnnotationBodyUpdateRequest,
    AnnotationCreateRequest,
    AnnotationRetargetRequest,
    DocumentAnnotationTarget,
    TextAnnotationTarget,
    TextSelector,
)


def text_selector() -> dict:
    return {
        "position": {"start": 4, "end": 8},
        "quote": {"exact": "text", "prefix": "pre", "suffix": "post"},
        "context": {"containerType": "paragraph", "headingPath": ["Design"]},
        "textRevision": "sha256:text",
        "documentRevision": "sha256:document",
    }


def test_annotation_create_request_accepts_document_and_text_targets() -> None:
    document = AnnotationCreateRequest.model_validate(
        {"path": " docs/design.md ", "body": " Whole file ", "target": {"type": "document"}}
    )
    text = AnnotationCreateRequest.model_validate(
        {
            "path": "docs/design.md",
            "body": "Selected text",
            "target": {"type": "text", "selector": text_selector()},
        }
    )

    assert document.path == "docs/design.md"
    assert document.body == "Whole file"
    assert isinstance(document.target, DocumentAnnotationTarget)
    assert isinstance(text.target, TextAnnotationTarget)
    assert text.target.selector.context.container_type == "paragraph"
    assert text.target.selector.model_dump(by_alias=True)["textRevision"] == "sha256:text"


@pytest.mark.parametrize(
    "payload",
    [
        {"path": "", "body": "Comment", "target": {"type": "document"}},
        {"path": "README.md", "body": "  ", "target": {"type": "document"}},
        {"path": "README.md", "body": "Comment", "target": {"type": "text"}},
        {
            "path": "README.md",
            "body": "Comment",
            "target": {"type": "text", "selector": {**text_selector(), "extra": True}},
        },
        {"path": "README.md", "body": "Comment", "target": {"type": "legacy"}},
    ],
)
def test_annotation_create_request_rejects_invalid_shape(payload) -> None:
    with pytest.raises(ValidationError):
        AnnotationCreateRequest.model_validate(payload)


@pytest.mark.parametrize(
    "selector_patch",
    [
        {"position": {"start": 4, "end": 4}},
        {"position": {"start": -1, "end": 4}},
        {"quote": {"exact": " ", "prefix": "", "suffix": ""}},
        {"context": {"containerType": " ", "headingPath": []}},
        {"context": {"containerType": "paragraph", "headingPath": [""]}},
        {"textRevision": ""},
        {"documentRevision": ""},
    ],
)
def test_text_selector_rejects_invalid_values(selector_patch) -> None:
    payload = text_selector()
    payload.update(selector_patch)
    with pytest.raises(ValidationError):
        TextSelector.model_validate(payload)


def test_body_update_only_accepts_a_non_empty_body() -> None:
    assert AnnotationBodyUpdateRequest(body=" Updated ").body == "Updated"
    with pytest.raises(ValidationError):
        AnnotationBodyUpdateRequest(body=" ")
    with pytest.raises(ValidationError):
        AnnotationBodyUpdateRequest.model_validate({"body": "Updated", "target": {}})


def test_retarget_requires_a_complete_text_target() -> None:
    request = AnnotationRetargetRequest.model_validate(
        {"target": {"type": "text", "selector": text_selector()}}
    )
    assert request.target.selector.quote.exact == "text"

    with pytest.raises(ValidationError):
        AnnotationRetargetRequest.model_validate({"target": {"type": "document"}})
