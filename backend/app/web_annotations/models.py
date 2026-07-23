from __future__ import annotations

import json
import math
import re
import unicodedata
from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend.app.web_annotations.url_identity import (
    MAX_WEB_ANNOTATION_URL_BYTES,
    WebUrlIdentity,
    normalize_page_reference_url,
    normalize_web_url,
    sanitize_url_reference,
)

MAX_ANNOTATION_BODY_CHARACTERS = 32 * 1024
MAX_ANNOTATION_TARGET_BYTES = 64 * 1024
MAX_ANNOTATION_PROPERTIES_BYTES = 16 * 1024
MAX_ANNOTATION_TAGS = 20
MAX_ANNOTATION_PROPERTIES = 20
MAX_STAGED_ASSET_IDS = 20
MAX_CSS_COORDINATE = 1_000_000

WebAnnotationScopeKind = Literal["session", "workspace", "global"]
WebAnnotationTargetType = Literal["text", "element", "region"]
StableAttributeName = Literal[
    "id",
    "name",
    "type",
    "href",
    "src",
    "alt",
    "title",
    "aria-label",
    "role",
]


class StrictWebAnnotationModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class WebAnnotationScope(StrictWebAnnotationModel):
    kind: WebAnnotationScopeKind
    id: str | None = Field(default=None, max_length=255)

    @field_validator("id")
    @classmethod
    def normalize_id(cls, value: str | None) -> str | None:
        return _normalize_optional_string(value, max_length=255)

    @model_validator(mode="after")
    def validate_scope(self) -> WebAnnotationScope:
        if self.kind == "global" and self.id is not None:
            raise ValueError("global scope cannot carry an id")
        if self.kind != "global" and self.id is None:
            raise ValueError(f"{self.kind} scope requires an id")
        return self


class WebAnnotationSource(StrictWebAnnotationModel):
    url: str
    title: str = Field(default="", max_length=512)
    canonical_url: str | None = None
    profile_mode: Literal["persistent", "incognito"] = "persistent"

    @field_validator("url")
    @classmethod
    def normalize_url(cls, value: str) -> str:
        return normalize_web_url(value).url_normalized

    @field_validator("canonical_url")
    @classmethod
    def normalize_canonical_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return normalize_page_reference_url(value)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        normalized = _normalize_display_string(value)
        if len(normalized) > 512:
            raise ValueError("title cannot exceed 512 characters")
        return normalized

    def identity(self) -> WebUrlIdentity:
        return normalize_web_url(self.url)


class CssRect(StrictWebAnnotationModel):
    x: float
    y: float
    width: float = Field(ge=0)
    height: float = Field(ge=0)

    @field_validator("x", "y", "width", "height")
    @classmethod
    def validate_number(cls, value: float) -> float:
        if isinstance(value, bool) or not math.isfinite(value):
            raise ValueError("CSS geometry must contain finite numbers")
        if abs(value) > MAX_CSS_COORDINATE:
            raise ValueError("CSS geometry exceeds the supported range")
        return value

    def require_positive_area(self, *, field_name: str) -> None:
        if self.width <= 0 or self.height <= 0:
            raise ValueError(f"{field_name} must have positive area")


class DomPathSegment(StrictWebAnnotationModel):
    child_index: int = Field(ge=0, le=1_000_000)
    shadow_root: bool


DomPath = Annotated[list[DomPathSegment], Field(min_length=1, max_length=128)]


class PersistedFrameLocator(StrictWebAnnotationModel):
    url: str
    name: str | None = Field(default=None, max_length=256)
    index_path: list[int] = Field(default_factory=list, max_length=32)
    parent_element_path: DomPath | None = None

    @field_validator("url")
    @classmethod
    def normalize_frame_url(cls, value: str) -> str:
        return normalize_page_reference_url(value, allow_about_blank=True)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str | None) -> str | None:
        return _normalize_optional_string(value, max_length=256, allow_empty=True)

    @field_validator("index_path")
    @classmethod
    def validate_index_path(cls, value: list[int]) -> list[int]:
        if any(isinstance(index, bool) or index < 0 or index > 1_000_000 for index in value):
            raise ValueError("frame index_path contains an invalid index")
        return value


class WebTextQuote(StrictWebAnnotationModel):
    exact: str = Field(min_length=1, max_length=8 * 1024)
    prefix: str = Field(default="", max_length=256)
    suffix: str = Field(default="", max_length=256)

    @field_validator("exact")
    @classmethod
    def validate_exact(cls, value: str) -> str:
        if not value:
            raise ValueError("text quote exact cannot be empty")
        return value


class WebTextPosition(StrictWebAnnotationModel):
    start: int = Field(ge=0, le=2_147_483_647)
    end: int = Field(ge=0, le=2_147_483_647)
    text_model_version: Literal[1]

    @model_validator(mode="after")
    def validate_range(self) -> WebTextPosition:
        if self.end <= self.start:
            raise ValueError("text position end must be greater than start")
        return self


class WebDomRange(StrictWebAnnotationModel):
    start_path: DomPath
    start_offset: int = Field(ge=0, le=2_147_483_647)
    end_path: DomPath
    end_offset: int = Field(ge=0, le=2_147_483_647)


class WebTextContext(StrictWebAnnotationModel):
    heading_path: list[str] = Field(default_factory=list, max_length=16)
    container_role: str | None = Field(default=None, max_length=128)
    container_text_digest: str | None = Field(default=None, max_length=128)

    @field_validator("heading_path")
    @classmethod
    def validate_headings(cls, value: list[str]) -> list[str]:
        return [_normalize_bounded_string(item, max_length=256, allow_empty=True) for item in value]

    @field_validator("container_role", "container_text_digest")
    @classmethod
    def validate_optional_context(cls, value: str | None) -> str | None:
        return _normalize_optional_string(value, max_length=128, allow_empty=True)


class WebTextTarget(StrictWebAnnotationModel):
    type: Literal["text"]
    quote: WebTextQuote
    position: WebTextPosition | None = None
    dom_range: WebDomRange | None = None
    context: WebTextContext
    rects: list[CssRect] = Field(min_length=1, max_length=128)
    frame: PersistedFrameLocator

    @model_validator(mode="after")
    def validate_target(self) -> WebTextTarget:
        for rect in self.rects:
            rect.require_positive_area(field_name="text rect")
        _validate_target_size(self)
        return self


class StableElementAttribute(StrictWebAnnotationModel):
    name: StableAttributeName
    value: str = Field(max_length=2_048)

    @field_validator("value")
    @classmethod
    def validate_value(cls, value: str, info) -> str:
        if len(value) > 2_048:
            raise ValueError("stable attribute value cannot exceed 2048 characters")
        name = info.data.get("name")
        if name in {"href", "src"}:
            return sanitize_url_reference(value)
        return _normalize_bounded_string(value, max_length=2_048, allow_empty=True)


class WebElementContext(StrictWebAnnotationModel):
    heading_path: list[str] = Field(default_factory=list, max_length=16)

    @field_validator("heading_path")
    @classmethod
    def validate_headings(cls, value: list[str]) -> list[str]:
        return [_normalize_bounded_string(item, max_length=256, allow_empty=True) for item in value]


class WebElementTarget(StrictWebAnnotationModel):
    type: Literal["element"]
    tag: str = Field(min_length=1, max_length=64)
    role: str | None = Field(default=None, max_length=128)
    accessible_name: str | None = Field(default=None, max_length=1_024)
    text_summary: str | None = Field(default=None, max_length=1_024)
    stable_attributes: list[StableElementAttribute] = Field(default_factory=list, max_length=20)
    path: DomPath
    shadow_host_path: DomPath | None = None
    context: WebElementContext
    rect: CssRect
    frame: PersistedFrameLocator

    @field_validator("tag")
    @classmethod
    def normalize_tag(cls, value: str) -> str:
        if not re.fullmatch(r"[a-z][a-z0-9-]*", value):
            raise ValueError("element tag must be lowercase and syntactically valid")
        return value

    @field_validator("role", "accessible_name", "text_summary")
    @classmethod
    def normalize_optional_summary(cls, value: str | None, info) -> str | None:
        limits = {"role": 128, "accessible_name": 1_024, "text_summary": 1_024}
        return _normalize_optional_string(
            value,
            max_length=limits[info.field_name],
            allow_empty=True,
        )

    @model_validator(mode="after")
    def validate_target(self) -> WebElementTarget:
        names = [attribute.name for attribute in self.stable_attributes]
        if len(set(names)) != len(names):
            raise ValueError("stable element attributes cannot contain duplicate names")
        self.rect.require_positive_area(field_name="element rect")
        _validate_target_size(self)
        return self


class ViewportSize(StrictWebAnnotationModel):
    width: float = Field(gt=0, le=MAX_CSS_COORDINATE)
    height: float = Field(gt=0, le=MAX_CSS_COORDINATE)

    @field_validator("width", "height")
    @classmethod
    def validate_number(cls, value: float) -> float:
        if isinstance(value, bool) or not math.isfinite(value):
            raise ValueError("viewport must contain finite numbers")
        return value


class ScrollPosition(StrictWebAnnotationModel):
    x: float = Field(ge=0, le=MAX_CSS_COORDINATE)
    y: float = Field(ge=0, le=MAX_CSS_COORDINATE)

    @field_validator("x", "y")
    @classmethod
    def validate_number(cls, value: float) -> float:
        if isinstance(value, bool) or not math.isfinite(value):
            raise ValueError("scroll position must contain finite numbers")
        return value


class WebRelativeElement(StrictWebAnnotationModel):
    path: DomPath
    rect: CssRect
    tag: str | None = Field(default=None, max_length=64)
    role: str | None = Field(default=None, max_length=128)
    accessible_name: str | None = Field(default=None, max_length=1_024)
    text_summary: str | None = Field(default=None, max_length=1_024)
    stable_attributes: list[StableElementAttribute] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def validate_rect(self) -> WebRelativeElement:
        self.rect.require_positive_area(field_name="relative element rect")
        if self.tag is not None and not re.fullmatch(r"[a-z][a-z0-9-]*", self.tag):
            raise ValueError("relative element tag must be lowercase and syntactically valid")
        names = [attribute.name for attribute in self.stable_attributes]
        if len(set(names)) != len(names):
            raise ValueError("relative element attributes cannot contain duplicate names")
        return self


class WebRegionVisualFingerprint(StrictWebAnnotationModel):
    fingerprint_version: Literal[1]
    local_digest: str
    perceptual_hash: str | None = None

    @field_validator("local_digest")
    @classmethod
    def validate_local_digest(cls, value: str) -> str:
        if not re.fullmatch(r"fnv1a32:[0-9a-f]{8}", value):
            raise ValueError("region local digest must use fnv1a32")
        return value

    @field_validator("perceptual_hash")
    @classmethod
    def validate_perceptual_hash(cls, value: str | None) -> str | None:
        if value is not None and not re.fullmatch(r"dhash64:[0-9a-f]{16}", value):
            raise ValueError("region perceptual hash must use dhash64")
        return value


class WebRegionTarget(StrictWebAnnotationModel):
    type: Literal["region"]
    rect: CssRect
    viewport: ViewportSize
    scroll: ScrollPosition
    relative_element: WebRelativeElement | None = None
    visual: WebRegionVisualFingerprint | None = None
    frame: PersistedFrameLocator

    @model_validator(mode="after")
    def validate_target(self) -> WebRegionTarget:
        self.rect.require_positive_area(field_name="region rect")
        if self.rect.x < 0 or self.rect.y < 0:
            raise ValueError("region rect must start inside the visible viewport")
        epsilon = 0.01
        if (
            self.rect.x + self.rect.width > self.viewport.width + epsilon
            or self.rect.y + self.rect.height > self.viewport.height + epsilon
        ):
            raise ValueError("region rect cannot extend beyond the visible viewport")
        _validate_target_size(self)
        return self


WebAnnotationTarget = Annotated[
    WebTextTarget | WebElementTarget | WebRegionTarget,
    Field(discriminator="type"),
]


class TextTypedProperty(StrictWebAnnotationModel):
    key: str = Field(min_length=1, max_length=64)
    type: Literal["text"]
    value: str = Field(max_length=8 * 1024)

    @field_validator("key")
    @classmethod
    def normalize_key(cls, value: str) -> str:
        return _normalize_property_key(value)


class NumberTypedProperty(StrictWebAnnotationModel):
    key: str = Field(min_length=1, max_length=64)
    type: Literal["number"]
    value: float

    @field_validator("key")
    @classmethod
    def normalize_key(cls, value: str) -> str:
        return _normalize_property_key(value)

    @field_validator("value")
    @classmethod
    def validate_value(cls, value: float) -> float:
        if isinstance(value, bool) or not math.isfinite(value):
            raise ValueError("number property must be finite")
        return value


class BooleanTypedProperty(StrictWebAnnotationModel):
    key: str = Field(min_length=1, max_length=64)
    type: Literal["boolean"]
    value: bool

    @field_validator("key")
    @classmethod
    def normalize_key(cls, value: str) -> str:
        return _normalize_property_key(value)


class DateTypedProperty(StrictWebAnnotationModel):
    key: str = Field(min_length=1, max_length=64)
    type: Literal["date"]
    value: str = Field(min_length=10, max_length=10)

    @field_validator("key")
    @classmethod
    def normalize_key(cls, value: str) -> str:
        return _normalize_property_key(value)

    @field_validator("value")
    @classmethod
    def validate_value(cls, value: str) -> str:
        try:
            parsed = date.fromisoformat(value)
        except ValueError as exc:
            raise ValueError("date property must use YYYY-MM-DD") from exc
        return parsed.isoformat()


class UrlTypedProperty(StrictWebAnnotationModel):
    key: str = Field(min_length=1, max_length=64)
    type: Literal["url"]
    value: str

    @field_validator("key")
    @classmethod
    def normalize_key(cls, value: str) -> str:
        return _normalize_property_key(value)

    @field_validator("value")
    @classmethod
    def normalize_value(cls, value: str) -> str:
        return normalize_web_url(value).url_normalized


TypedProperty = Annotated[
    TextTypedProperty
    | NumberTypedProperty
    | BooleanTypedProperty
    | DateTypedProperty
    | UrlTypedProperty,
    Field(discriminator="type"),
]


class WebAnnotationCreateRequest(StrictWebAnnotationModel):
    schema_version: Literal[1] = 1
    scope: WebAnnotationScope
    source: WebAnnotationSource
    target: WebAnnotationTarget
    body_markdown: str
    tags: list[str] = Field(default_factory=list, max_length=MAX_ANNOTATION_TAGS)
    properties: list[TypedProperty] = Field(
        default_factory=list,
        max_length=MAX_ANNOTATION_PROPERTIES,
    )
    staged_asset_ids: list[str] = Field(default_factory=list, max_length=MAX_STAGED_ASSET_IDS)

    @field_validator("body_markdown")
    @classmethod
    def validate_body(cls, value: str) -> str:
        _validate_character_count(value, MAX_ANNOTATION_BODY_CHARACTERS, "body_markdown")
        return value

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, value: list[str]) -> list[str]:
        return _normalize_tags(value)

    @field_validator("staged_asset_ids")
    @classmethod
    def validate_asset_ids(cls, value: list[str]) -> list[str]:
        return _validate_ids(value, field_name="staged_asset_ids")

    @model_validator(mode="after")
    def validate_request(self) -> WebAnnotationCreateRequest:
        _validate_properties(self.properties)
        _validate_target_size(self.target)
        return self


class WebAnnotationPatchRequest(StrictWebAnnotationModel):
    schema_version: Literal[1] = 1
    expected_revision: int = Field(ge=1)
    body_markdown: str | None = None
    tags: list[str] | None = Field(default=None, max_length=MAX_ANNOTATION_TAGS)
    properties: list[TypedProperty] | None = Field(
        default=None,
        max_length=MAX_ANNOTATION_PROPERTIES,
    )

    @field_validator("body_markdown")
    @classmethod
    def validate_body(cls, value: str | None) -> str | None:
        if value is not None:
            _validate_character_count(value, MAX_ANNOTATION_BODY_CHARACTERS, "body_markdown")
        return value

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return _normalize_tags(value)

    @model_validator(mode="after")
    def validate_request(self) -> WebAnnotationPatchRequest:
        if self.body_markdown is None and self.tags is None and self.properties is None:
            raise ValueError("patch request must change at least one field")
        if self.properties is not None:
            _validate_properties(self.properties)
        return self


class WebAnnotationRetargetRequest(StrictWebAnnotationModel):
    schema_version: Literal[1] = 1
    expected_revision: int = Field(ge=1)
    target: WebAnnotationTarget
    reason: Literal["user_retarget"] = "user_retarget"
    staged_asset_ids: list[str] = Field(default_factory=list, max_length=MAX_STAGED_ASSET_IDS)

    @field_validator("staged_asset_ids")
    @classmethod
    def validate_asset_ids(cls, value: list[str]) -> list[str]:
        return _validate_ids(value, field_name="staged_asset_ids")

    @model_validator(mode="after")
    def validate_request(self) -> WebAnnotationRetargetRequest:
        _validate_target_size(self.target)
        return self


class WebAnnotationResourceRecord(StrictWebAnnotationModel):
    id: str = Field(min_length=1, max_length=128)
    scope: WebAnnotationScope
    normalization_version: Literal[1]
    url_key: str = Field(pattern=r"^[0-9a-f]{64}$")
    url_normalized: str
    document_url: str
    canonical_url: str | None = None
    origin: str
    title: str = Field(default="", max_length=512)
    created_at: str
    updated_at: str

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        normalized = _normalize_display_string(value)
        if len(normalized) > 512:
            raise ValueError("title cannot exceed 512 characters")
        return normalized

    @field_validator("canonical_url")
    @classmethod
    def normalize_canonical_url(cls, value: str | None) -> str | None:
        return normalize_page_reference_url(value) if value is not None else None

    @model_validator(mode="after")
    def validate_identity(self) -> WebAnnotationResourceRecord:
        identity = normalize_web_url(self.url_normalized)
        if (
            self.normalization_version != identity.normalization_version
            or self.url_key != identity.url_key
            or self.document_url != identity.document_url
            or self.origin != identity.origin
        ):
            raise ValueError("resource URL identity fields are inconsistent")
        return self


class WebAnnotationRecord(StrictWebAnnotationModel):
    id: str = Field(min_length=1, max_length=128)
    resource_id: str = Field(min_length=1, max_length=128)
    target_schema_version: Literal[1]
    target: WebAnnotationTarget
    body_markdown: str
    tags: list[str] = Field(default_factory=list, max_length=MAX_ANNOTATION_TAGS)
    properties: list[TypedProperty] = Field(
        default_factory=list,
        max_length=MAX_ANNOTATION_PROPERTIES,
    )
    revision: int = Field(ge=1)
    created_at: str
    updated_at: str

    @field_validator("body_markdown")
    @classmethod
    def validate_body(cls, value: str) -> str:
        _validate_character_count(value, MAX_ANNOTATION_BODY_CHARACTERS, "body_markdown")
        return value

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, value: list[str]) -> list[str]:
        return _normalize_tags(value)

    @model_validator(mode="after")
    def validate_record(self) -> WebAnnotationRecord:
        _validate_properties(self.properties)
        _validate_target_size(self.target)
        return self


class WebAnnotationTargetHistoryRecord(StrictWebAnnotationModel):
    id: str = Field(min_length=1, max_length=128)
    annotation_id: str = Field(min_length=1, max_length=128)
    prior_revision: int = Field(ge=1)
    target_schema_version: Literal[1]
    target: WebAnnotationTarget
    reason: Literal["user_retarget", "migration"]
    created_at: str

    @model_validator(mode="after")
    def validate_record(self) -> WebAnnotationTargetHistoryRecord:
        _validate_target_size(self.target)
        return self


class WebAnnotationAssetRecord(StrictWebAnnotationModel):
    id: str = Field(min_length=1, max_length=128)
    resource_id: str = Field(min_length=1, max_length=128)
    annotation_id: str | None = Field(default=None, min_length=1, max_length=128)
    asset_kind: Literal["region_screenshot"]
    state: Literal["staged", "attached"]
    storage_path: str = Field(min_length=1, max_length=4_096)
    mime_type: Literal["image/png", "image/jpeg", "image/webp"]
    size_bytes: int = Field(gt=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    expires_at: str | None = None
    created_at: str
    updated_at: str

    @model_validator(mode="after")
    def validate_state(self) -> WebAnnotationAssetRecord:
        if self.state == "staged":
            if self.annotation_id is not None or self.expires_at is None:
                raise ValueError("staged asset requires expiry and cannot carry annotation_id")
        elif self.annotation_id is None or self.expires_at is not None:
            raise ValueError("attached asset requires annotation_id and cannot carry expiry")
        return self


class WebAnnotationMessageAttachmentCloneRequest(StrictWebAnnotationModel):
    schema_version: Literal[1] = 1
    session_id: str = Field(min_length=1, max_length=255)
    context_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")

    @field_validator("session_id")
    @classmethod
    def normalize_session_id(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("session_id cannot be empty")
        return normalized


class WebAnnotationMessageAttachmentRecord(StrictWebAnnotationModel):
    id: str = Field(min_length=1, max_length=128)
    attachment_id: str = Field(min_length=1, max_length=128)
    session_id: str = Field(min_length=1, max_length=255)
    user_id: str = Field(min_length=1, max_length=255)
    type: Literal["image"]
    source: Literal["web_annotation"]
    name: str = Field(min_length=1, max_length=180)
    path: str = Field(min_length=1, max_length=4_096)
    mime_type: Literal["image/png", "image/jpeg", "image/webp"]
    size: int = Field(gt=0)
    created_at: str
    updated_at: str


class WebAnnotationAttachmentCloneRecord(StrictWebAnnotationModel):
    id: str = Field(min_length=1, max_length=128)
    session_id: str = Field(min_length=1, max_length=255)
    annotation_id: str = Field(min_length=1, max_length=128)
    asset_id: str = Field(min_length=1, max_length=128)
    context_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    attachment_id: str = Field(min_length=1, max_length=128)
    created_at: str


class WebAnnotationMessageAttachmentCloneResponse(StrictWebAnnotationModel):
    schema_version: Literal[1] = 1
    annotation_id: str = Field(min_length=1, max_length=128)
    asset_id: str = Field(min_length=1, max_length=128)
    context_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    reused: bool
    attachment: WebAnnotationMessageAttachmentRecord


class WebAnnotationItem(StrictWebAnnotationModel):
    resource: WebAnnotationResourceRecord
    annotation: WebAnnotationRecord


class WebAnnotationDetail(WebAnnotationItem):
    target_history: list[WebAnnotationTargetHistoryRecord] = Field(default_factory=list)
    assets: list[WebAnnotationAssetRecord] = Field(default_factory=list)


class WebAnnotationPage(StrictWebAnnotationModel):
    items: list[WebAnnotationItem]
    next_cursor: str | None = None


class WebAnnotationErrorDetail(StrictWebAnnotationModel):
    code: str
    message: str
    details: dict[str, object] = Field(default_factory=dict)


def _validate_properties(properties: list[TypedProperty]) -> None:
    keys = [item.key.casefold() for item in properties]
    if len(set(keys)) != len(keys):
        raise ValueError("properties cannot contain duplicate normalized keys")
    payload = [item.model_dump(mode="json") for item in properties]
    if _json_bytes(payload) > MAX_ANNOTATION_PROPERTIES_BYTES:
        raise ValueError(
            f"properties cannot exceed {MAX_ANNOTATION_PROPERTIES_BYTES} UTF-8 JSON bytes"
        )


def _normalize_tags(value: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for tag in value:
        normalized = _normalize_bounded_string(tag, max_length=64)
        identity = normalized.casefold()
        if identity in seen:
            continue
        seen.add(identity)
        result.append(normalized)
    return result


def _validate_target_size(target: BaseModel) -> None:
    if _json_bytes(target.model_dump(mode="json")) > MAX_ANNOTATION_TARGET_BYTES:
        raise ValueError(f"target cannot exceed {MAX_ANNOTATION_TARGET_BYTES} UTF-8 JSON bytes")


def _validate_ids(values: list[str], *, field_name: str) -> list[str]:
    if len(set(values)) != len(values):
        raise ValueError(f"{field_name} cannot contain duplicates")
    for value in values:
        if not re.fullmatch(r"[A-Za-z0-9._:@/-]{1,128}", value):
            raise ValueError(f"{field_name} contains an invalid id")
    return values


def _normalize_property_key(value: str) -> str:
    normalized = _normalize_bounded_string(value, max_length=64)
    if any(character in normalized for character in {"\x00", "\r", "\n"}):
        raise ValueError("property key contains a forbidden character")
    return normalized


def _normalize_display_string(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip()


def _normalize_bounded_string(
    value: str,
    *,
    max_length: int,
    allow_empty: bool = False,
) -> str:
    normalized = _normalize_display_string(value)
    if not allow_empty and not normalized:
        raise ValueError("value cannot be empty")
    if len(normalized) > max_length:
        raise ValueError(f"value cannot exceed {max_length} characters")
    if "\x00" in normalized:
        raise ValueError("value contains a forbidden null character")
    return normalized


def _normalize_optional_string(
    value: str | None,
    *,
    max_length: int,
    allow_empty: bool = False,
) -> str | None:
    if value is None:
        return None
    normalized = _normalize_bounded_string(
        value,
        max_length=max_length,
        allow_empty=allow_empty,
    )
    return normalized or None


def _validate_utf8_size(value: str, limit: int, field_name: str) -> None:
    if len(value.encode("utf-8")) > limit:
        raise ValueError(f"{field_name} cannot exceed {limit} UTF-8 bytes")


def _validate_character_count(value: str, limit: int, field_name: str) -> None:
    if len(value) > limit:
        raise ValueError(f"{field_name} cannot exceed {limit} characters")


def _json_bytes(value: object) -> int:
    return len(
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )


__all__ = [
    "MAX_ANNOTATION_BODY_CHARACTERS",
    "MAX_ANNOTATION_PROPERTIES",
    "MAX_ANNOTATION_PROPERTIES_BYTES",
    "MAX_ANNOTATION_TAGS",
    "MAX_ANNOTATION_TARGET_BYTES",
    "MAX_STAGED_ASSET_IDS",
    "MAX_WEB_ANNOTATION_URL_BYTES",
    "BooleanTypedProperty",
    "CssRect",
    "DateTypedProperty",
    "DomPathSegment",
    "NumberTypedProperty",
    "PersistedFrameLocator",
    "ScrollPosition",
    "StableElementAttribute",
    "TextTypedProperty",
    "TypedProperty",
    "UrlTypedProperty",
    "ViewportSize",
    "WebAnnotationCreateRequest",
    "WebAnnotationPatchRequest",
    "WebAnnotationPage",
    "WebAnnotationRecord",
    "WebAnnotationItem",
    "WebAnnotationDetail",
    "WebAnnotationErrorDetail",
    "WebAnnotationResourceRecord",
    "WebAnnotationRetargetRequest",
    "WebAnnotationScope",
    "WebAnnotationSource",
    "WebAnnotationTarget",
    "WebAnnotationTargetHistoryRecord",
    "WebAnnotationAssetRecord",
    "WebDomRange",
    "WebElementContext",
    "WebElementTarget",
    "WebRegionTarget",
    "WebRegionVisualFingerprint",
    "WebRelativeElement",
    "WebTextContext",
    "WebTextPosition",
    "WebTextQuote",
    "WebTextTarget",
]
