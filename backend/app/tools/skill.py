from __future__ import annotations

import json
from typing import Annotated, Any, Protocol

from langchain_core.messages import ToolMessage
from langchain_core.tools import InjectedToolCallId, tool
from langgraph.types import Command

from backend.app.core.logger import logger
from backend.app.core.request_context import (
    get_keydex_capability,
    get_keydex_snapshot,
    get_skill_catalog,
)
from backend.app.keydex.capabilities.skills import (
    SKILLS_CAPABILITY_KEY,
    EffectiveSkillsPayload,
)
from backend.app.keydex.capabilities.skills.consumer import effective_skill_catalog
from backend.app.keydex.runtime import KeydexEffectiveRuntimeSnapshot
from backend.app.keydex.skills import (
    EffectiveSkillCatalog,
    SkillCatalog,
    SkillDefinition,
    SkillResourcePathError,
    SkillTextResource,
)
from backend.app.tools.skill_activation_messages import build_skill_activation_content

LOAD_SKILL_TOOL_NAME = "load_skill"


class _FrozenSkillsSnapshot(Protocol):
    def read_skill_text_resource(
        self,
        skill: SkillDefinition,
        resource_path: str,
    ) -> SkillTextResource: ...


@tool
async def load_skill(
    skill_name: Annotated[str, "Effective Keydex skill name to activate."],
    tool_call_id: Annotated[str, InjectedToolCallId],
    source: Annotated[
        str | None,
        "Optional expected winner source (builtin, system, or workspace).",
    ] = None,
    resource_path: Annotated[
        str | None,
        "Optional resource path relative to the skill root. Omit it to activate the skill.",
    ] = None,
) -> Command:
    """Activate an effective Keydex skill or read one of its text resources."""

    return await run_load_skill(
        skill_name=skill_name,
        tool_call_id=tool_call_id,
        source=source,
        resource_path=resource_path,
    )


async def run_load_skill(
    *,
    skill_name: str,
    tool_call_id: str,
    source: str | None = None,
    resource_path: str | None = None,
) -> Command:
    requested_skill = str(skill_name or "").strip()
    requested_source = str(source or "").strip()
    resource_path_text = str(resource_path or "").strip()
    if not requested_skill:
        return _tool_response(
            {
                "skill_name": requested_skill,
                "found": False,
                "loaded": False,
                "injected": False,
                "code": "skill_name_empty",
                "message": "skill_name must not be empty.",
            },
            tool_call_id,
        )

    skills_snapshot = _resolve_frozen_skills_snapshot()
    if skills_snapshot is None:
        legacy_catalog = get_skill_catalog()
        snapshot_missing = isinstance(
            legacy_catalog,
            (EffectiveSkillCatalog, SkillCatalog),
        )
        return _tool_response(
            {
                "skill_name": requested_skill,
                "found": False,
                "loaded": False,
                "injected": False,
                "code": (
                    "skill_snapshot_missing"
                    if snapshot_missing
                    else "skill_catalog_missing"
                ),
                "message": (
                    "The effective Skills snapshot is unavailable for this request."
                    if snapshot_missing
                    else "No effective skill catalog is available for this request."
                ),
            },
            tool_call_id,
        )
    catalog = _catalog_for_frozen_snapshot(skills_snapshot)

    skill = catalog.skills.get(requested_skill)
    if skill is None:
        return _tool_response(
            {
                "skill_name": requested_skill,
                "found": False,
                "loaded": False,
                "injected": False,
                "code": "skill_not_found",
                "message": f"Skill '{requested_skill}' was not found.",
            },
            tool_call_id,
        )
    if requested_source and requested_source != skill.source:
        return _tool_response(
            {
                "skill_name": requested_skill,
                "requested_source": requested_source,
                "winner_source": skill.source,
                "found": True,
                "loaded": False,
                "injected": False,
                "code": "skill_source_stale",
                "message": "Skill source no longer matches the effective winner.",
            },
            tool_call_id,
        )

    if resource_path_text:
        return _load_skill_resource(
            skill=skill,
            skills_snapshot=skills_snapshot,
            requested_skill=requested_skill,
            resource_path=resource_path_text,
            tool_call_id=tool_call_id,
        )

    try:
        skill_md_content = _read_skill_entry(skill, skills_snapshot=skills_snapshot)
    except FileNotFoundError:
        return _tool_response(
            {
                "skill_name": requested_skill,
                "source": skill.source,
                "locator": skill.relative_entry,
                "found": True,
                "loaded": False,
                "injected": False,
                "code": "skill_entry_missing",
                "message": "Skill entry file SKILL.md is missing.",
            },
            tool_call_id,
        )
    except SkillResourcePathError as exc:
        return _tool_response(
            {
                "skill_name": requested_skill,
                "source": skill.source,
                "locator": skill.relative_entry,
                "found": True,
                "loaded": False,
                "injected": False,
                "code": exc.code,
                "message": exc.reason,
            },
            tool_call_id,
        )

    try:
        activation_content = _build_activation_content(skill, skill_md_content)
    except Exception:
        logger.opt(exception=True).error(
            f"[load_skill] failed to build skill activation content | skill={requested_skill}"
        )
        return _tool_response(
            {
                "skill_name": requested_skill,
                "source": skill.source,
                "locator": skill.relative_entry,
                "found": True,
                "loaded": True,
                "injected": False,
                "code": "skill_activation_failed",
                "message": "skill 已加载，但激活未完成。",
            },
            tool_call_id,
        )
    logger.info(f"[load_skill] activated skill | skill={requested_skill}")
    return _tool_response(
        {
            "skill_name": requested_skill,
            "source": skill.source,
            "locator": skill.relative_entry,
            "found": True,
            "loaded": True,
            "injected": True,
            "message": "skill 已激活。",
        },
        tool_call_id,
        pending_skill_activations=[
            {
                "id": f"skill:{skill.source}:{skill.name}",
                "skill_name": requested_skill,
                "source": skill.source,
                "locator": skill.relative_entry,
                "content": activation_content,
            }
        ],
    )


def _read_skill_entry(
    skill: SkillDefinition,
    *,
    skills_snapshot: _FrozenSkillsSnapshot,
) -> str:
    try:
        return skills_snapshot.read_skill_text_resource(skill, "SKILL.md").content
    except SkillResourcePathError as exc:
        if exc.code == "skill_resource_not_found":
            raise FileNotFoundError(str(skill.entry_file)) from exc
        mapped_code = {
            "skill_resource_too_large": "skill_entry_too_large",
            "skill_resource_not_text": "skill_entry_not_text",
            "skill_resource_not_file": "skill_entry_invalid",
        }.get(exc.code, exc.code)
        raise SkillResourcePathError(mapped_code, exc.reason) from exc


def _load_skill_resource(
    *,
    skill: SkillDefinition,
    skills_snapshot: _FrozenSkillsSnapshot,
    requested_skill: str,
    resource_path: str,
    tool_call_id: str,
) -> Command:
    try:
        resource = skills_snapshot.read_skill_text_resource(skill, resource_path)
    except SkillResourcePathError as exc:
        return _tool_response(
            {
                "skill_name": requested_skill,
                "source": skill.source,
                "locator": skill.relative_entry,
                "resource_path": resource_path,
                "found": True,
                "loaded": False,
                "injected": False,
                "code": exc.code,
                "message": exc.reason,
            },
            tool_call_id,
        )

    return _tool_response(
        {
            "skill_name": requested_skill,
            "source": skill.source,
            "locator": skill.relative_entry,
            "resource_path": resource_path,
            "found": True,
            "loaded": True,
            "injected": False,
            "message": "Skill resource file loaded.",
            "content": resource.content,
            "encoding": resource.encoding,
            "revision": resource.revision,
        },
        tool_call_id,
    )


def _resolve_frozen_skills_snapshot() -> _FrozenSkillsSnapshot | None:
    payload = get_keydex_capability(SKILLS_CAPABILITY_KEY)
    if isinstance(payload, EffectiveSkillsPayload):
        return payload

    snapshot = get_keydex_snapshot()
    if isinstance(snapshot, KeydexEffectiveRuntimeSnapshot):
        return snapshot
    return None


def _catalog_for_frozen_snapshot(
    snapshot: _FrozenSkillsSnapshot,
) -> EffectiveSkillCatalog | SkillCatalog:
    if isinstance(snapshot, EffectiveSkillsPayload):
        return snapshot.catalog
    if isinstance(snapshot, KeydexEffectiveRuntimeSnapshot):
        catalog = effective_skill_catalog(snapshot)
        if catalog is not None:
            return catalog
    raise TypeError("unsupported frozen Skills snapshot")


def _build_activation_content(skill: SkillDefinition, skill_md_content: str) -> str:
    return build_skill_activation_content(
        skill=skill,
        skill_md_content=skill_md_content,
        load_skill_tool_name=LOAD_SKILL_TOOL_NAME,
    )


def _tool_response(
    payload: dict[str, Any],
    tool_call_id: str,
    *,
    pending_skill_activations: list[dict[str, Any]] | None = None,
) -> Command:
    update: dict[str, Any] = {
        "messages": [
            ToolMessage(
                content=json.dumps(payload, ensure_ascii=False),
                tool_call_id=tool_call_id,
                name=LOAD_SKILL_TOOL_NAME,
            )
        ],
    }
    if pending_skill_activations is not None:
        update["pending_skill_activations"] = pending_skill_activations
    return Command(update=update)
