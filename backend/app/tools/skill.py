from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Any

from langchain_core.messages import ToolMessage
from langchain_core.tools import InjectedToolCallId, tool
from langgraph.types import Command

from backend.app.core.logger import logger
from backend.app.core.request_context import get_skill_catalog
from backend.app.keydex.skills import (
    KEYDEX_SKILL_MAX_ENTRY_BYTES,
    KEYDEX_SKILL_MAX_RESOURCE_BYTES,
    SkillCatalog,
    SkillDefinition,
    SkillResourcePathError,
    ensure_skill_file_size,
    resolve_skill_resource_path,
)
from backend.app.tools.skill_activation_messages import build_skill_activation_content

LOAD_SKILL_TOOL_NAME = "load_skill"


@tool
async def load_skill(
    skill_name: Annotated[str, "Workspace skill name to activate."],
    tool_call_id: Annotated[str, InjectedToolCallId],
    resource_path: Annotated[
        str | None,
        "Optional resource path relative to the skill root. Omit it to activate the skill.",
    ] = None,
) -> Command:
    """Activate a workspace skill or read one of its resource files."""

    return await run_load_skill(
        skill_name=skill_name,
        tool_call_id=tool_call_id,
        resource_path=resource_path,
    )


async def run_load_skill(
    *,
    skill_name: str,
    tool_call_id: str,
    resource_path: str | None = None,
) -> Command:
    requested_skill = str(skill_name or "").strip()
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

    catalog = get_skill_catalog()
    if not isinstance(catalog, SkillCatalog):
        return _tool_response(
            {
                "skill_name": requested_skill,
                "found": False,
                "loaded": False,
                "injected": False,
                "code": "skill_catalog_missing",
                "message": "No workspace skill catalog is available for this request.",
            },
            tool_call_id,
        )

    skill = catalog.skills.get(requested_skill)
    if skill is None:
        return _tool_response(
            {
                "skill_name": requested_skill,
                "found": False,
                "loaded": False,
                "injected": False,
                "code": "skill_not_found",
                "message": f"Workspace skill '{requested_skill}' was not found.",
            },
            tool_call_id,
        )

    if resource_path_text:
        return _load_skill_resource(
            skill=skill,
            requested_skill=requested_skill,
            resource_path=resource_path_text,
            tool_call_id=tool_call_id,
        )

    try:
        skill_md_content = _read_skill_entry(skill)
    except FileNotFoundError:
        return _tool_response(
            {
                "skill_name": requested_skill,
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
                "found": True,
                "loaded": True,
                "injected": False,
                "code": "skill_activation_failed",
                "message": "skill 已加载，但激活未完成。",
            },
            tool_call_id,
        )
    logger.info(f"[load_skill] activated workspace skill | skill={requested_skill}")
    return _tool_response(
        {
            "skill_name": requested_skill,
            "found": True,
            "loaded": True,
            "injected": True,
            "message": "skill 已激活。",
        },
        tool_call_id,
        pending_skill_activations=[
            {
                "skill_name": requested_skill,
                "content": activation_content,
            }
        ],
    )


def _read_skill_entry(skill: SkillDefinition) -> str:
    entry_file = Path(skill.entry_file).resolve()
    if not entry_file.is_file():
        raise FileNotFoundError(str(entry_file))
    ensure_skill_file_size(
        entry_file,
        max_bytes=KEYDEX_SKILL_MAX_ENTRY_BYTES,
        code="skill_entry_too_large",
    )
    return entry_file.read_text(encoding="utf-8", errors="replace")


def _load_skill_resource(
    *,
    skill: SkillDefinition,
    requested_skill: str,
    resource_path: str,
    tool_call_id: str,
) -> Command:
    try:
        resolved = resolve_skill_resource_path(skill, resource_path)
    except SkillResourcePathError as exc:
        return _tool_response(
            {
                "skill_name": requested_skill,
                "resource_path": resource_path,
                "found": True,
                "loaded": False,
                "injected": False,
                "code": exc.code,
                "message": exc.reason,
            },
            tool_call_id,
        )

    if not resolved.exists():
        return _tool_response(
            {
                "skill_name": requested_skill,
                "resource_path": resource_path,
                "found": True,
                "loaded": False,
                "injected": False,
                "code": "skill_resource_not_found",
                "message": "Skill resource file was not found.",
            },
            tool_call_id,
        )
    if resolved.is_dir():
        return _tool_response(
            {
                "skill_name": requested_skill,
                "resource_path": resource_path,
                "found": True,
                "loaded": False,
                "injected": False,
                "code": "skill_resource_not_file",
                "message": "Skill resource path points to a directory.",
            },
            tool_call_id,
        )
    try:
        ensure_skill_file_size(
            resolved,
            max_bytes=KEYDEX_SKILL_MAX_RESOURCE_BYTES,
            code="skill_resource_too_large",
        )
        content = resolved.read_text(encoding="utf-8")
    except SkillResourcePathError as exc:
        return _tool_response(
            {
                "skill_name": requested_skill,
                "resource_path": resource_path,
                "found": True,
                "loaded": False,
                "injected": False,
                "code": exc.code,
                "message": exc.reason,
            },
            tool_call_id,
        )
    except UnicodeDecodeError:
        return _tool_response(
            {
                "skill_name": requested_skill,
                "resource_path": resource_path,
                "found": True,
                "loaded": False,
                "injected": False,
                "code": "skill_resource_not_text",
                "message": "Skill resource file must be valid UTF-8 text.",
            },
            tool_call_id,
        )

    return _tool_response(
        {
            "skill_name": requested_skill,
            "resource_path": resource_path,
            "found": True,
            "loaded": True,
            "injected": False,
            "message": "Skill resource file loaded.",
            "content": content,
        },
        tool_call_id,
    )


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
