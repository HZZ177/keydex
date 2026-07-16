from __future__ import annotations

from typing import Any

from backend.app.keydex.capabilities.skills.capability import (
    SKILLS_CAPABILITY_KEY,
    EffectiveSkillsPayload,
)
from backend.app.keydex.models import KeydexDiagnostic, KeydexEffectiveSnapshot
from backend.app.keydex.skills.model import (
    EffectiveSkillCatalog,
    SkillCatalog,
    SkillDefinition,
)
from backend.app.keydex.skills.security import (
    SkillResourcePathError,
    SkillTextResource,
)


def effective_skills_payload(snapshot: Any) -> EffectiveSkillsPayload | None:
    if not isinstance(snapshot, KeydexEffectiveSnapshot):
        return None
    payload = snapshot.get(SKILLS_CAPABILITY_KEY)
    return payload if isinstance(payload, EffectiveSkillsPayload) else None


def effective_skill_catalog(
    snapshot: Any,
) -> EffectiveSkillCatalog | SkillCatalog | None:
    payload = effective_skills_payload(snapshot)
    if payload is not None:
        return payload.catalog
    catalog = getattr(snapshot, "skill_catalog", None)
    return catalog if isinstance(catalog, (EffectiveSkillCatalog, SkillCatalog)) else None


def effective_capability_fingerprints(snapshot: Any) -> dict[str, str]:
    if isinstance(snapshot, KeydexEffectiveSnapshot):
        return {
            capability_id: capability.fingerprint
            for capability_id, capability in snapshot.capabilities.items()
        }
    fingerprint = str(getattr(snapshot, "fingerprint", "") or "")
    return {"skills": fingerprint} if fingerprint else {}


def effective_skills_fingerprint(snapshot: Any) -> str:
    if isinstance(snapshot, KeydexEffectiveSnapshot):
        capability = snapshot.capabilities.get(SKILLS_CAPABILITY_KEY.name)
        return capability.fingerprint if capability is not None else ""
    return str(getattr(snapshot, "fingerprint", "") or "")


def effective_skills_diagnostics(snapshot: Any) -> tuple[KeydexDiagnostic, ...]:
    if isinstance(snapshot, KeydexEffectiveSnapshot):
        capability = snapshot.capabilities.get(SKILLS_CAPABILITY_KEY.name)
        return capability.diagnostics if capability is not None else ()
    return tuple(getattr(snapshot, "diagnostics", ()) or ())


def read_effective_skill_text_resource(
    snapshot: Any,
    skill: SkillDefinition,
    resource_path: str,
) -> SkillTextResource:
    payload = effective_skills_payload(snapshot)
    if payload is not None:
        return payload.read_skill_text_resource(skill, resource_path)
    reader = getattr(snapshot, "read_skill_text_resource", None)
    if callable(reader):
        return reader(skill, resource_path)
    raise SkillResourcePathError(
        "skill_snapshot_missing",
        "The effective Skills snapshot is unavailable for this request.",
    )
