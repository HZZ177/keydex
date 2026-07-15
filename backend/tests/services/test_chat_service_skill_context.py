from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.core.config import AppSettings
from backend.app.core.request_context import (
    get_keydex_snapshot,
    get_skill_catalog,
    get_tool_call_preset,
    reset_request_context,
)
from backend.app.core.time import to_iso_z, utc_now
from backend.app.keydex import KeydexRuntimeCache
from backend.app.services import ChatRequest, ChatService
from backend.app.services.chat_service import (
    SkillActivationRequest,
    _build_skill_activation_preset,
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
        agent_runner=object(),
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


def _workspace_session(tmp_path: Path):
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
    return service, session, workspace_root


def test_skill_activation_preset_maps_only_to_load_skill() -> None:
    preset = _build_skill_activation_preset(
        SkillActivationRequest(skill_name="dev-plan", origin="slash")
    )

    assert preset is not None
    assert preset.type == "force"
    assert preset.producer == "skill_activation"
    assert preset.calls[0].name == "load_skill"
    assert preset.calls[0].args == {"skill_name": "dev-plan", "source": "workspace"}
    assert preset.metadata == {"source": "workspace", "origin": "slash"}


def test_tool_context_uses_validated_keydex_snapshot(tmp_path: Path) -> None:
    service, session, workspace_root = _workspace_session(tmp_path)
    snapshot = service.keydex_runtime_cache.get_workspace_snapshot(workspace_root)

    tool_context, enable_tools = service._build_tool_context(
        request=ChatRequest(
            session_id=session.id, message="use skill", provider_id="provider-1", model="qwen-coder"
        ),
        session=session,
        trace_id="trace-1",
        turn_index=1,
        keydex_snapshot=snapshot,
    )

    assert enable_tools is True
    assert tool_context.metadata["keydex_snapshot"] is snapshot
    assert tool_context.metadata["skill_catalog"] is snapshot.skill_catalog
    assert tool_context.metadata["keydex_mode"] == "workspace_effective"
    assert tool_context.metadata["enable_workspace_tools"] is True
    assert tool_context.metadata["enable_skill_tools"] is True


def test_agent_runtime_context_sets_snapshot_catalog_and_force_preset(tmp_path: Path) -> None:
    service, session, workspace_root = _workspace_session(tmp_path)
    snapshot = service.keydex_runtime_cache.get_workspace_snapshot(workspace_root)
    tool_context, _enable_tools = service._build_tool_context(
        request=ChatRequest(
            session_id=session.id, message="use skill", provider_id="provider-1", model="qwen-coder"
        ),
        session=session,
        trace_id="trace-1",
        turn_index=1,
        keydex_snapshot=snapshot,
    )

    token = service._set_agent_runtime_context(
        tool_context=tool_context,
        skill_activation=SkillActivationRequest(skill_name="dev-plan"),
    )
    try:
        assert get_keydex_snapshot() is snapshot
        assert get_skill_catalog() is snapshot.skill_catalog
        preset = get_tool_call_preset()
        assert preset is not None
        assert preset.calls[0].name == "load_skill"
        assert preset.calls[0].args == {"skill_name": "dev-plan", "source": "workspace"}
    finally:
        reset_request_context(token)

    assert get_keydex_snapshot() is None
    assert get_skill_catalog() is None
    assert get_tool_call_preset() is None


def test_chat_tool_context_uses_system_snapshot_without_enabling_workspace_tools(
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
    snapshot = service._resolve_session_keydex_snapshot(session)

    tool_context, enable_tools = service._build_tool_context(
        request=ChatRequest(session_id=session.id, message="use global"),
        session=session,
        trace_id="trace-chat",
        turn_index=1,
        keydex_snapshot=snapshot,
    )

    assert enable_tools is False
    assert tool_context.metadata["keydex_snapshot"] is snapshot
    assert tool_context.metadata["skill_catalog"].skills["global"].source == "system"
    assert tool_context.metadata["enable_workspace_tools"] is False
    assert tool_context.metadata["enable_skill_tools"] is True
    assert tool_context.workspace_root == service.settings.data_dir


@pytest.mark.asyncio
async def test_chat_service_rejects_empty_message_with_only_skill_activation(
    tmp_path: Path,
) -> None:
    service, _repositories = _service(tmp_path)

    with pytest.raises(ValueError, match="请输入要使用该 Skill 处理的内容"):
        await service.handle_chat(
            ChatRequest(
                message="",
                provider_id="provider-1",
                model="qwen-coder",
                runtime_params={"skill_activation": {"skill_name": "dev-plan"}},
            )
        )
