from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class AnnotationModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class TextPosition(AnnotationModel):
    start: int = Field(ge=0)
    end: int = Field(gt=0)

    @model_validator(mode="after")
    def validate_range(self) -> TextPosition:
        if self.end <= self.start:
            raise ValueError("Annotation position end must be greater than start")
        return self


class TextQuote(AnnotationModel):
    exact: str
    prefix: str = ""
    suffix: str = ""

    @field_validator("exact")
    @classmethod
    def validate_exact(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Annotation quote exact cannot be empty")
        return value


class TextContext(AnnotationModel):
    container_type: str = Field(alias="containerType")
    heading_path: list[str] = Field(default_factory=list, alias="headingPath")

    @field_validator("container_type")
    @classmethod
    def normalize_container_type(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Annotation context containerType cannot be empty")
        return normalized

    @field_validator("heading_path")
    @classmethod
    def normalize_heading_path(cls, value: list[str]) -> list[str]:
        normalized = [item.strip() for item in value]
        if any(not item for item in normalized):
            raise ValueError("Annotation context headingPath cannot contain empty entries")
        return normalized


class TextSelector(AnnotationModel):
    position: TextPosition
    quote: TextQuote
    context: TextContext
    text_revision: str = Field(alias="textRevision")
    document_revision: str = Field(alias="documentRevision")

    @field_validator("text_revision", "document_revision")
    @classmethod
    def normalize_revision(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Annotation revision cannot be empty")
        return normalized


class DocumentAnnotationTarget(AnnotationModel):
    type: Literal["document"]


class TextAnnotationTarget(AnnotationModel):
    type: Literal["text"]
    selector: TextSelector


AnnotationTarget = Annotated[
    DocumentAnnotationTarget | TextAnnotationTarget,
    Field(discriminator="type"),
]


class AnnotationCreateRequest(AnnotationModel):
    path: str
    body: str
    target: AnnotationTarget

    @field_validator("path", "body")
    @classmethod
    def normalize_required_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Annotation path and body cannot be empty")
        return normalized


class AnnotationBodyUpdateRequest(AnnotationModel):
    body: str

    @field_validator("body")
    @classmethod
    def normalize_body(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Annotation body cannot be empty")
        return normalized


class AnnotationRetargetRequest(AnnotationModel):
    target: TextAnnotationTarget


class AnnotationRecord(AnnotationModel):
    id: str
    workspace_id: str
    document_path: str
    target: AnnotationTarget
    body: str
    created_at: str
    updated_at: str


class AnnotationErrorDetail(AnnotationModel):
    code: str
    message: str
