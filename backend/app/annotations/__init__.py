"""Workspace document annotations domain."""

from backend.app.annotations.models import (
    AnnotationBodyUpdateRequest,
    AnnotationCreateRequest,
    AnnotationRecord,
    AnnotationRetargetRequest,
    AnnotationTarget,
    DocumentAnnotationTarget,
    TextAnnotationTarget,
    TextSelector,
)

__all__ = [
    "AnnotationBodyUpdateRequest",
    "AnnotationCreateRequest",
    "AnnotationRecord",
    "AnnotationRetargetRequest",
    "AnnotationTarget",
    "DocumentAnnotationTarget",
    "TextAnnotationTarget",
    "TextSelector",
]
