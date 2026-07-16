from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.core.config import AppSettings
from backend.app.core.time import to_iso_z, utc_now
from backend.app.keydex import KeydexRuntimeCache
from backend.app.services import ChatRequest, ChatService
from backend.app.services.chat_service import (
    MessageInjectionRole,
    MessageInjectionType,
    SkillActivationError,
    SkillActivationRequest,
    _build_message_injection_items,
    _build_skill_activation_request,
)
from backend.app.storage import (
    MODEL_DEFAULT_CHAT,
    ModelProviderRecord,
    StorageRepositories,
    init_database,
)


def _service(tmp_path: Path) -> tuple[ChatService, StorageRepositories]:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    _configure_model_default(repositories)
    service = ChatService(
        settings=AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path),
        repositories=repositories,
        agent_runner=object(),  # validation tests fail before agent execution
        keydex_runtime_cache=KeydexRuntimeCache(system_root=tmp_path / "system-keydex"),
    )
    return service, repositories


def _configure_model_default(repositories: StorageRepositories) -> None:
    now = to_iso_z(utc_now())
    provider = ModelProviderRecord(
        id="provider-1",
        name="测试模型服务",
        base_url="http://model.test/v1",
        api_key="test-key",
        enabled=True,
        models=["qwen-coder"],
        model_enabled={},
        health={},
        created_at=now,
        updated_at=now,
    )
    repositories.model_providers.upsert(provider)
    repositories.model_providers.set_model_default(
        scope=MODEL_DEFAULT_CHAT,
        provider_id=provider.id,
        model="qwen-coder",
    )


def _write_skill(workspace: Path, name: str = "dev-plan") -> None:
    skill_dir = workspace / ".keydex" / "skills" / name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"""---
name: {name}
description: Build a structured development plan.
---

# {name}
""",
        encoding="utf-8",
    )


def test_skill_activation_parser_supports_snake_case() -> None:
    activation = _build_skill_activation_request(
        {
            "skill_activation": {
                "skill_name": "dev-plan",
                "source": "workspace",
                "origin": "slash",
            }
        }
    )

    assert activation == SkillActivationRequest(
        skill_name="dev-plan",
        source="workspace",
        origin="slash",
    )


def test_skill_activation_parser_supports_camel_case() -> None:
    activation = _build_skill_activation_request(
        {
            "skillActivation": {
                "skillName": "dev-plan",
                "source": "workspace",
                "origin": "slash",
            }
        }
    )

    assert activation == SkillActivationRequest(
        skill_name="dev-plan",
        source="workspace",
        origin="slash",
    )


def test_skill_activation_parser_rejects_invalid_public_shape() -> None:
    with pytest.raises(SkillActivationError) as not_object:
        _build_skill_activation_request({"skill_activation": "dev-plan"})
    assert not_object.value.code == "skill_activation_invalid"

    with pytest.raises(SkillActivationError) as empty_name:
        _build_skill_activation_request({"skill_activation": {"skill_name": ""}})
    assert empty_name.value.code == "skill_activation_invalid"

    system = _build_skill_activation_request(
        {"skill_activation": {"skill_name": "dev-plan", "source": "system"}}
    )
    assert system == SkillActivationRequest(skill_name="dev-plan", source="system")

    builtin = _build_skill_activation_request(
        {"skill_activation": {"skill_name": "keydex-guide", "source": "builtin"}}
    )
    assert builtin == SkillActivationRequest(skill_name="keydex-guide", source="builtin")

    with pytest.raises(SkillActivationError) as source_unsupported:
        _build_skill_activation_request(
            {"skill_activation": {"skill_name": "dev-plan", "source": "remote"}}
        )
    assert source_unsupported.value.code == "skill_source_unsupported"


def test_skill_activation_parser_rejects_public_tool_call_preset() -> None:
    with pytest.raises(SkillActivationError) as exc_info:
        _build_skill_activation_request(
            {
                "tool_call_preset": {
                    "type": "force",
                    "calls": [{"name": "load_skill", "args": {"skill_name": "dev-plan"}}],
                }
            }
        )
    assert exc_info.value.code == "skill_activation_invalid"


def test_skill_activation_does_not_break_message_injection_parser() -> None:
    items = _build_message_injection_items(
        {
            "skill_activation": {"skill_name": "dev-plan"},
            "message_injection": [
                {
                    "type": MessageInjectionType.FOLLOW.value,
                    "role": MessageInjectionRole.SYSTEM.value,
                    "content": "extra context",
                }
            ],
        }
    )

    assert len(items) == 1
    assert items[0].content == "extra context"


@pytest.mark.asyncio
async def test_t37_chat_service_accepts_system_skill_activation_for_chat_session(
    tmp_path: Path,
) -> None:
    service, repositories = _service(tmp_path)
    skill_root = tmp_path / "system-keydex" / "skills" / "global"
    skill_root.mkdir(parents=True)
    (skill_root / "SKILL.md").write_text(
        "---\nname: global\ndescription: Global skill\n---\n\nbody\n",
        encoding="utf-8",
    )
    session = repositories.sessions.create(
        session_id="ses-chat",
        user_id="local-user",
        scene_id="desktop-agent",
    )

    snapshot = service._validate_skill_activation(
        SkillActivationRequest(skill_name="global", source="system"),
        session,
    )

    assert snapshot.mode == "system_only"
    assert snapshot.skill_catalog.skills["global"].source == "system"


@pytest.mark.asyncio
async def test_chat_service_rejects_missing_workspace_skill(tmp_path: Path) -> None:
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
            provider_id="provider-1",
            model="qwen-coder",
            runtime_params={"skill_activation": {"skill_name": "dev-plan"}},
        )
    )

    assert result.status == "failed"
    assert result.error == "Skill does not exist or has been deleted"
    events = repositories.message_events.list_by_session(session.id)
    assert events[-1].data["code"] == "skill_not_found"
    assert events[-1].data["details"] == {"skill_name": "dev-plan"}


def test_chat_service_accepts_existing_workspace_skill(tmp_path: Path) -> None:
    service, repositories = _service(tmp_path)
    workspace_root = tmp_path / "repo"
    _write_skill(workspace_root)
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

    service._validate_skill_activation(
        SkillActivationRequest(skill_name="dev-plan"),
        session,
    )


def test_t38_workspace_override_rejects_stale_system_activation(tmp_path: Path) -> None:
    service, repositories = _service(tmp_path)
    system_skill = tmp_path / "system-keydex" / "skills" / "dev-plan"
    system_skill.mkdir(parents=True)
    (system_skill / "SKILL.md").write_text(
        "---\nname: dev-plan\ndescription: System\n---\n", encoding="utf-8"
    )
    workspace_root = tmp_path / "repo"
    _write_skill(workspace_root)
    workspace = repositories.workspaces.create(
        workspace_id="ws-project", root_path=workspace_root
    )
    session = repositories.sessions.create(
        session_id="ses-project",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(workspace_root),
        workspace_roots=[str(workspace_root)],
    )

    with pytest.raises(SkillActivationError) as exc_info:
        service._validate_skill_activation(
            SkillActivationRequest(skill_name="dev-plan", source="system"),
            session,
        )

    assert exc_info.value.code == "skill_source_stale"
    assert exc_info.value.details["winner_source"] == "workspace"


def test_t39_invalid_workspace_override_blocks_inherited_system_activation(
    tmp_path: Path,
) -> None:
    service, repositories = _service(tmp_path)
    system_skill = tmp_path / "system-keydex" / "skills" / "shared"
    system_skill.mkdir(parents=True)
    (system_skill / "SKILL.md").write_text(
        "---\nname: shared\ndescription: System\n---\n", encoding="utf-8"
    )
    workspace_root = tmp_path / "repo"
    (workspace_root / ".keydex" / "skills" / "shared").mkdir(parents=True)
    workspace = repositories.workspaces.create(
        workspace_id="ws-project", root_path=workspace_root
    )
    session = repositories.sessions.create(
        session_id="ses-project",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(workspace_root),
        workspace_roots=[str(workspace_root)],
    )

    with pytest.raises(SkillActivationError) as exc_info:
        service._validate_skill_activation(
            SkillActivationRequest(skill_name="shared", source="system"),
            session,
        )

    assert exc_info.value.code == "skill_shadow_barrier"
    assert exc_info.value.details == {"skill_name": "shared"}


def test_removed_inherit_manifest_cannot_disable_system_skill(tmp_path: Path) -> None:
    service, repositories = _service(tmp_path)
    system_skill = tmp_path / "system-keydex" / "skills" / "shared"
    system_skill.mkdir(parents=True)
    (system_skill / "SKILL.md").write_text(
        "---\nname: shared\ndescription: System\n---\n", encoding="utf-8"
    )
    workspace_root = tmp_path / "repo"
    keydex_root = workspace_root / ".keydex"
    keydex_root.mkdir(parents=True)
    (keydex_root / "keydex.md").write_text(
        '{"skills": {"inherit_system": false}}', encoding="utf-8"
    )
    workspace = repositories.workspaces.create(
        workspace_id="ws-project", root_path=workspace_root
    )
    session = repositories.sessions.create(
        session_id="ses-project",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(workspace_root),
        workspace_roots=[str(workspace_root)],
    )

    snapshot = service._validate_skill_activation(
        SkillActivationRequest(skill_name="shared", source="system"),
        session,
    )

    assert snapshot.skill_catalog.skills["shared"].source == "system"
