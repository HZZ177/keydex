from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.app.core.config import AppSettings
from backend.app.core.request_context import reset_request_context, set_request_context
from backend.app.core.time import to_iso_z, utc_now
from backend.app.keydex import KeydexCapabilityRuntimeCache
from backend.app.services import ChatRequest, ChatService
from backend.app.services.chat_service import (
    SkillActivationError,
    SkillActivationRequest,
    _build_skill_activation_request,
)
from backend.app.storage import (
    MODEL_DEFAULT_CHAT,
    ModelProviderRecord,
    StorageRepositories,
    init_database,
)
from backend.app.tools.skill import run_load_skill


def _service(tmp_path: Path) -> tuple[ChatService, StorageRepositories]:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    _configure_model_default(repositories)
    service = ChatService(
        settings=AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path),
        repositories=repositories,
        agent_runner=object(),
        keydex_runtime_cache=KeydexCapabilityRuntimeCache(
            builtin_root=tmp_path / "builtin-keydex",
            system_root=tmp_path / "system-keydex",
        ),
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


def _write_layer_skill(layer_root: Path, name: str) -> Path:
    skill_dir = layer_root / "skills" / name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                f"name: {name}",
                f"description: {name} layer skill.",
                "---",
                "",
                f"# {name}",
            ]
        ),
        encoding="utf-8",
    )
    return skill_dir


def test_skill_activation_parser_exposes_stable_error_codes() -> None:
    with pytest.raises(SkillActivationError) as invalid_shape:
        _build_skill_activation_request({"skill_activation": "dev-plan"})
    assert invalid_shape.value.code == "skill_activation_invalid"

    with pytest.raises(SkillActivationError) as unsupported_source:
        _build_skill_activation_request(
            {"skill_activation": {"skill_name": "dev-plan", "source": "remote"}}
        )
    assert unsupported_source.value.code == "skill_source_unsupported"


def test_unavailable_workspace_layer_preserves_parent_catalog_and_reports_not_found(
    tmp_path: Path,
) -> None:
    service, repositories = _service(tmp_path)
    workspace_root = tmp_path / "repo-invalid"
    workspace_root.mkdir()
    keydex_root = workspace_root / ".keydex"
    keydex_root.write_text("not a directory", encoding="utf-8")
    workspace = repositories.workspaces.create(
        workspace_id="ws-invalid",
        root_path=workspace_root,
    )
    session = repositories.sessions.create(
        session_id="ses-invalid",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(workspace_root),
        workspace_roots=[str(workspace_root)],
    )
    snapshot = service.keydex_runtime_cache.get_workspace_snapshot(workspace_root)

    with pytest.raises(SkillActivationError) as exc_info:
        service._validate_skill_activation(
            SkillActivationRequest(skill_name="shared", source="workspace"),
            session,
            snapshot=snapshot,
        )

    assert exc_info.value.code == "skill_not_found"
    assert exc_info.value.details == {"skill_name": "shared"}


def test_shadow_barrier_uses_specific_activation_error(tmp_path: Path) -> None:
    service, repositories = _service(tmp_path)
    _write_layer_skill(tmp_path / "system-keydex", "shared")
    workspace_root = tmp_path / "repo-shadowed"
    (workspace_root / ".keydex" / "skills" / "shared").mkdir(parents=True)
    workspace = repositories.workspaces.create(
        workspace_id="ws-shadowed",
        root_path=workspace_root,
    )
    session = repositories.sessions.create(
        session_id="ses-shadowed",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(workspace_root),
        workspace_roots=[str(workspace_root)],
    )
    snapshot = service.keydex_runtime_cache.get_workspace_snapshot(workspace_root)

    with pytest.raises(SkillActivationError) as exc_info:
        service._validate_skill_activation(
            SkillActivationRequest(skill_name="shared", source="system"),
            session,
            snapshot=snapshot,
        )

    assert exc_info.value.code == "skill_shadow_barrier"
    assert exc_info.value.details == {"skill_name": "shared"}


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
            provider_id="provider-1",
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
    snapshot = KeydexCapabilityRuntimeCache(
        builtin_root=tmp_path / "builtin-keydex",
        system_root=tmp_path / "system-keydex",
    ).get_workspace_snapshot(tmp_path)
    token = set_request_context(keydex_snapshot=snapshot)
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
