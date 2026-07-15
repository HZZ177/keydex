from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from backend.app.core.time import to_iso_z
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


def effective_skills_response(
    snapshot: KeydexEffectiveRuntimeSnapshot,
) -> EffectiveSkillsResponse:
    return EffectiveSkillsResponse(
        mode=snapshot.mode,
        workspace_root=(
            snapshot.workspace_root.as_posix()
            if snapshot.workspace_root is not None
            else None
        ),
        fingerprint=snapshot.fingerprint,
        loaded_at=to_iso_z(snapshot.loaded_at),
        skills=[
            SkillSummary(
                name=skill.name,
                description=skill.description,
                source=skill.source,
                label=f"/{skill.name}",
                locator=skill.relative_entry,
            )
            for skill in snapshot.skill_catalog.sorted_skills()
        ],
        diagnostics=[
            KeydexDiagnosticPayload(**diagnostic.to_dict()) for diagnostic in snapshot.diagnostics
        ],
    )
