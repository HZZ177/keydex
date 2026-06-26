from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.app.core.config import AppSettings
from backend.app.core.request_context import reset_request_context, set_request_context
from backend.app.keydex.models import KeydexWorkspaceProfile
from backend.app.keydex.skills import discover_workspace_skills
from backend.app.services import ChatRequest, ChatService
from backend.app.services.chat_service import SkillActivationError, _build_skill_activation_request
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools.skill import run_load_skill


def _service(tmp_path: Path) -> tuple[ChatService, StorageRepositories]:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    service = ChatService(
        settings=AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path),
        repositories=repositories,
        agent_runner=object(),
    )
    return service, repositories


def _write_skill(workspace: Path, name: str = "dev-plan") -> Path:
    skill_dir = workspace / ".keydex" / "skills" / name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                f"name: {name}",
                "description: Build a structured development plan.",
                "---",
                "",
                f"# {name}",
            ]
        ),
        encoding="utf-8",
    )
    return skill_dir


def _catalog(workspace: Path):
    return discover_workspace_skills(
        KeydexWorkspaceProfile(
            workspace_root=workspace,
            keydex_root=workspace / ".keydex",
            skills_root=workspace / ".keydex" / "skills",
        )
    )


def test_skill_activation_parser_exposes_stable_error_codes() -> None:
    with pytest.raises(SkillActivationError) as invalid_shape:
        _build_skill_activation_request({"skill_activation": "dev-plan"})
    assert invalid_shape.value.code == "skill_activation_invalid"

    with pytest.raises(SkillActivationError) as unsupported_source:
        _build_skill_activation_request(
            {"skill_activation": {"skill_name": "dev-plan", "source": "system"}}
        )
    assert unsupported_source.value.code == "skill_source_unsupported"


@pytest.mark.asyncio
async def test_missing_skill_turn_failure_uses_stable_code_without_absolute_paths(
    tmp_path: Path,
) -> None:
    service, repositories = _service(tmp_path)
    workspace_root = tmp_path / "repo"
    workspace_root.mkdir()
    workspace = repositories.workspaces.create(workspace_id="ws-project", root_path=workspace_root)
    session = repositories.sessions.create(
        session_id="ses-project",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(workspace_root),
        workspace_roots=[str(workspace_root)],
    )

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="use skill",
            model="qwen-coder",
            runtime_params={"skill_activation": {"skill_name": "dev-plan"}},
        )
    )

    assert result.status == "failed"
    events = repositories.message_events.list_by_session(session.id)
    payload = events[-1].data
    assert payload["code"] == "skill_not_found"
    assert payload["details"] == {"skill_name": "dev-plan"}
    serialized = json.dumps(payload, ensure_ascii=False)
    assert str(workspace_root) not in serialized


@pytest.mark.asyncio
async def test_load_skill_resource_security_error_is_structured(tmp_path: Path) -> None:
    _write_skill(tmp_path)
    token = set_request_context(skill_catalog=_catalog(tmp_path))
    try:
        command = await run_load_skill(
            skill_name="dev-plan",
            resource_path="../secret.md",
            tool_call_id="call_1",
        )
    finally:
        reset_request_context(token)

    payload = json.loads(command.update["messages"][0].content)
    assert payload["code"] == "skill_resource_forbidden"
    assert payload["found"] is True
    assert payload["loaded"] is False
    assert str(tmp_path) not in payload["message"]
