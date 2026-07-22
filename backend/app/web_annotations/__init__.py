"""Web annotation domain models and services."""

from backend.app.web_annotations.models import (
    WebAnnotationAssetRecord,
    WebAnnotationCreateRequest,
    WebAnnotationPatchRequest,
    WebAnnotationRecord,
    WebAnnotationResourceRecord,
    WebAnnotationRetargetRequest,
    WebAnnotationSource,
    WebAnnotationTarget,
    WebAnnotationTargetHistoryRecord,
)
from backend.app.web_annotations.url_identity import (
    WEB_ANNOTATION_URL_NORMALIZATION_VERSION,
    WebUrlIdentity,
    WebUrlIdentityError,
    normalize_web_url,
)

__all__ = [
    "WEB_ANNOTATION_URL_NORMALIZATION_VERSION",
    "WebAnnotationAssetRecord",
    "WebAnnotationCreateRequest",
    "WebAnnotationPatchRequest",
    "WebAnnotationRecord",
    "WebAnnotationResourceRecord",
    "WebAnnotationRetargetRequest",
    "WebAnnotationSource",
    "WebAnnotationTarget",
    "WebAnnotationTargetHistoryRecord",
    "WebUrlIdentity",
    "WebUrlIdentityError",
    "normalize_web_url",
]
