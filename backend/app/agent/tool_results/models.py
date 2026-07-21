from __future__ import annotations

from typing import Any, Literal, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field

from backend.app.agent.tool_results.budgets import ToolResultPolicy

# ToolExecutionResult metadata may carry this process-local value from a provider
# boundary to the LangChain adapter.  It must never be merged into model/UI
# payloads; the adapter consumes it only to persist the lossless safe result.
INTERNAL_ARTIFACT_SOURCE_KEY = "_keydex_internal_artifact_source"


class ToolResultProjectionMeta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["keydex.tool_projection.v1"] = "keydex.tool_projection.v1"
    tool_name: str
    full_bytes: int = Field(ge=0)
    model_bytes: int = Field(ge=0)
    approximate_full_tokens: int = Field(ge=0)
    approximate_model_tokens: int = Field(ge=0)
    budget_bytes: int = Field(gt=0)
    truncated: bool
    continuation: dict[str, Any] | None = None
    artifact_id: str | None = None
    artifact_complete: bool = True
    reason_code: str | None = None


class KeydexToolMessageArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["keydex.tool_artifact.v1"] = "keydex.tool_artifact.v1"
    display_payload: Any
    projection: ToolResultProjectionMeta
    persisted_ref: dict[str, Any] | None = None
    governance: dict[str, Any] | None = None


class ToolResultProjection(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True, extra="forbid")

    model_content: str
    display_payload: Any
    meta: ToolResultProjectionMeta
    persisted_ref: dict[str, Any] | None = None

    def runtime_artifact(self) -> dict[str, Any]:
        return KeydexToolMessageArtifact(
            display_payload=self.display_payload,
            projection=self.meta,
            persisted_ref=self.persisted_ref,
        ).model_dump(mode="json")


@runtime_checkable
class ToolResultProjector(Protocol):
    def __call__(
        self,
        result: Any,
        *,
        tool_name: str,
        policy: ToolResultPolicy,
        context: Any,
    ) -> ToolResultProjection: ...
