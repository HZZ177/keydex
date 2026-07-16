from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from backend.app.core.time import to_iso_z
from backend.app.keydex.capabilities.keydex_markdown import (
    KEYDEX_MARKDOWN_CAPABILITY_KEY,
)
from backend.app.keydex.capabilities.skills.consumer import (
    effective_skill_catalog,
    effective_skills_diagnostics,
    effective_skills_fingerprint,
)
from backend.app.keydex.models import KeydexEffectiveSnapshot
from backend.app.keydex.runtime import KeydexEffectiveRuntimeSnapshot


class KeydexDiagnosticPayload(BaseModel):
    code: str
    reason: str
    path: str | None = None
    severity: Literal["warning", "error"] = "warning"
    details: dict = Field(default_factory=dict)


class SkillSummary(BaseModel):
    name: str
    description: str
    source: Literal["builtin", "system", "workspace"]
    label: str
    locator: str


class EffectiveSkillsResponse(BaseModel):
    mode: Literal["system_only", "workspace_effective"]
    workspace_root: str | None = None
    fingerprint: str
    loaded_at: str
    skills: list[SkillSummary]
    diagnostics: list[KeydexDiagnosticPayload]


class RuntimeDiagnosticPayload(BaseModel):
    code: str
    reason: str
    severity: Literal["warning", "error"] = "warning"
    details: dict = Field(default_factory=dict)
    capability_id: str | None = None
    scope: Literal["builtin", "system", "workspace"] | None = None
    logical_path: str | None = None


class RuntimeLayerCapabilityOverview(BaseModel):
    supported: bool
    available: bool
    state: Literal["loaded", "empty", "failed", "unsupported"]
    fingerprint: str
    sources: list[str]
    diagnostics: list[RuntimeDiagnosticPayload]


class RuntimeLayerOverview(BaseModel):
    scope: Literal["builtin", "system", "workspace"]
    fingerprint: str
    capabilities: dict[str, RuntimeLayerCapabilityOverview]


class RuntimeCapabilityOverview(BaseModel):
    available: bool
    fingerprint: str
    sources: list[str]
    diagnostics: list[RuntimeDiagnosticPayload]
    count: int | None = None
    document_count: int | None = None
    total_bytes: int | None = None


class RuntimeOverviewResponse(BaseModel):
    mode: Literal["system_only", "workspace_effective"]
    fingerprint: str
    loaded_at: str
    layers: list[RuntimeLayerOverview]
    capabilities: dict[str, RuntimeCapabilityOverview]
    diagnostics: list[RuntimeDiagnosticPayload]


def effective_skills_response(
    snapshot: KeydexEffectiveSnapshot | KeydexEffectiveRuntimeSnapshot,
) -> EffectiveSkillsResponse:
    catalog = effective_skill_catalog(snapshot)
    if catalog is None:
        raise RuntimeError("Keydex snapshot is missing the Skills capability")
    return EffectiveSkillsResponse(
        mode=snapshot.mode,
        workspace_root=(
            snapshot.workspace_root.as_posix()
            if snapshot.workspace_root is not None
            else None
        ),
        fingerprint=effective_skills_fingerprint(snapshot),
        loaded_at=to_iso_z(snapshot.loaded_at),
        skills=[
            SkillSummary(
                name=skill.name,
                description=skill.description,
                source=skill.source,
                label=f"/{skill.name}",
                locator=skill.relative_entry,
            )
            for skill in catalog.sorted_skills()
        ],
        diagnostics=[
            KeydexDiagnosticPayload(**diagnostic.to_dict())
            for diagnostic in effective_skills_diagnostics(snapshot)
        ],
    )


def runtime_overview_response(
    snapshot: KeydexEffectiveSnapshot,
) -> RuntimeOverviewResponse:
    catalog = effective_skill_catalog(snapshot)
    markdown = snapshot.get(KEYDEX_MARKDOWN_CAPABILITY_KEY)
    capabilities: dict[str, RuntimeCapabilityOverview] = {}
    for capability_id, capability in snapshot.capabilities.items():
        common = {
            "available": capability.available,
            "fingerprint": capability.fingerprint,
            "sources": list(capability.sources),
            "diagnostics": [
                _runtime_diagnostic(diagnostic)
                for diagnostic in capability.diagnostics
            ],
        }
        if capability_id == "skills":
            capabilities[capability_id] = RuntimeCapabilityOverview(
                **common,
                count=len(catalog.skills) if catalog is not None else 0,
            )
        elif capability_id == "keydex_markdown":
            documents = markdown.documents if markdown is not None else ()
            capabilities[capability_id] = RuntimeCapabilityOverview(
                **common,
                document_count=len(documents),
                total_bytes=sum(document.byte_size for document in documents),
            )
        else:
            capabilities[capability_id] = RuntimeCapabilityOverview(**common)

    return RuntimeOverviewResponse(
        mode=snapshot.mode,
        fingerprint=snapshot.fingerprint,
        loaded_at=to_iso_z(snapshot.loaded_at),
        layers=[
            RuntimeLayerOverview(
                scope=layer.scope,
                fingerprint=layer.fingerprint,
                capabilities={
                    capability_id: RuntimeLayerCapabilityOverview(
                        supported=capability.supported,
                        available=capability.available,
                        state=capability.state,
                        fingerprint=capability.fingerprint,
                        sources=list(capability.sources),
                        diagnostics=[
                            _runtime_diagnostic(diagnostic)
                            for diagnostic in capability.diagnostics
                        ],
                    )
                    for capability_id, capability in layer.capabilities.items()
                },
            )
            for layer in snapshot.layers
        ],
        capabilities=capabilities,
        diagnostics=[
            _runtime_diagnostic(diagnostic) for diagnostic in snapshot.diagnostics
        ],
    )


def _runtime_diagnostic(diagnostic) -> RuntimeDiagnosticPayload:
    return RuntimeDiagnosticPayload(
        code=diagnostic.code,
        reason=diagnostic.reason,
        severity=diagnostic.severity,
        details=dict(diagnostic.details),
        capability_id=diagnostic.capability_id,
        scope=diagnostic.scope,
        logical_path=diagnostic.logical_path,
    )
