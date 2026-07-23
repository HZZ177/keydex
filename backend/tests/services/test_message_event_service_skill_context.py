from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.core.config import AppSettings
from backend.app.events import TurnCompletedAggregator
from backend.app.keydex import KeydexRuntimeCache
from backend.app.services import ChatRequest, ChatService, MessageEventService
from backend.app.services.chat_service import SkillActivationRequest
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path: Path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses-history",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    return repositories


def _append(
    repositories: StorageRepositories,
    event_id: str,
    action: str,
    data: dict,
) -> None:
    repositories.message_events.append(
        event_id=event_id,
        session_id="ses-history",
        turn_index=1,
        action=action,
        data=data,
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
This body must not be stored in contextItems.
""",
        encoding="utf-8",
    )


def test_message_event_service_restores_skill_activation_context_item(
    tmp_path: Path,
) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)

    _append(
        repositories,
        "evt_skill",
        "system_message",
        {
            "source": "skill_activation",
            "skill_name": "dev-plan",
            "skillName": "dev-plan",
            "label": "/dev-plan",
            "description": "Build a structured development plan.",
            "metadata": {
                "id": "skill:dev-plan",
                "type": "skill",
                "label": "/dev-plan",
                "skill_name": "dev-plan",
                "description": "Build a structured development plan.",
            },
        },
    )
    _append(repositories, "evt_user", "user_message", {"content": "拆 issues"})

    messages = service.get_display_messages("ses-history")

    assert len(messages) == 1
    item = messages[0]["contextItems"][0]
    assert item["id"] == "skill:workspace:dev-plan"
    assert item["type"] == "skill"
    assert item["label"] == "/dev-plan"
    assert item["skill_name"] == "dev-plan"
    assert item["source"] == "workspace"
    assert item["description"] == "Build a structured development plan."
    assert item["locator"] == ""
    assert item["origin"] is None
    assert item["metadata"]["id"] == "skill:workspace:dev-plan"
    assert item["metadata"]["source"] == "workspace"
    assert "This body must not be stored" not in str(item)


def test_message_event_service_keeps_same_name_sources_distinct(tmp_path: Path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)

    for source in ("builtin", "system", "workspace"):
        _append(
            repositories,
            f"evt_{source}",
            "system_message",
            {
                "source": "skill_activation",
                "id": f"skill:{source}:shared",
                "skill_name": "shared",
                "skill_source": source,
                "description": f"{source} description",
                "locator": ".keydex/skills/shared/SKILL.md",
                "origin": "slash",
                "metadata": {
                    "id": f"skill:{source}:shared",
                    "source": source,
                    "origin": "slash",
                    "locator": ".keydex/skills/shared/SKILL.md",
                },
            },
        )
    _append(repositories, "evt_user", "user_message", {"content": "use shared"})

    items = service.get_display_messages("ses-history")[0]["contextItems"]

    assert [item["id"] for item in items] == [
        "skill:builtin:shared",
        "skill:system:shared",
        "skill:workspace:shared",
    ]
    assert [item["source"] for item in items] == ["builtin", "system", "workspace"]
    assert all(item["locator"] == ".keydex/skills/shared/SKILL.md" for item in items)
    assert all(item["origin"] == "slash" for item in items)


@pytest.mark.parametrize("source", ["builtin", "system", "workspace"])
def test_message_event_service_preserves_load_skill_source_in_deferred_history(
    tmp_path: Path,
    source: str,
) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)

    _append(
        repositories,
        "evt_tool_start",
        "tool_start",
        {
            "tool": "load_skill",
            "params": {"skill_name": "shared", "source": source},
            "run_id": "load_shared",
            "tool_call_id": "call_shared",
        },
    )
    _append(
        repositories,
        "evt_tool_end",
        "tool_end",
        {
            "tool": "load_skill",
            "run_id": "load_shared",
            "tool_call_id": "call_shared",
            "duration_ms": 5,
            "result": {
                "skill_name": "shared",
                "source": source,
                "locator": ".keydex/skills/shared/SKILL.md",
                "loaded": True,
                "injected": True,
            },
        },
    )

    message = service.get_display_messages(
        "ses-history",
        include_tool_details=False,
    )[0]

    assert message["toolDetailsDeferred"] is True
    assert message["toolSummary"]["source"] == source
    assert message["toolParams"] == {"skill_name": "shared", "source": source}
    assert message["uiPayload"]["source"] == source


@pytest.mark.asyncio
async def test_chat_service_emits_skill_activation_context_before_user_message(
    tmp_path: Path,
) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    service = ChatService(
        settings=AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path),
        repositories=repositories,
        agent_runner=object(),
        keydex_runtime_cache=KeydexRuntimeCache(system_root=tmp_path / "system-keydex"),
    )
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
    snapshot = service.keydex_runtime_cache.get_workspace_snapshot(workspace_root)
    dispatcher = service._build_turn_dispatcher(
        session_id=session.id,
        turn_index=1,
        chat_adapter=None,
        aggregator=TurnCompletedAggregator(),
    )
    request = ChatRequest(
        session_id=session.id,
        message="拆 issues",
        model="qwen-coder",
        client_input_id="client-input-skill-1",
    )

    await service._emit_skill_activation_context(
        dispatcher=dispatcher,
        request=request,
        session=session,
        trace_id="trace-1",
        root_node_id="trace-1-root",
        turn_index=1,
        skill_activation=SkillActivationRequest(skill_name="dev-plan", origin="slash"),
        keydex_snapshot=snapshot,
    )
    await service._emit_user_message(
        dispatcher=dispatcher,
        request=request,
        session=session,
        trace_id="trace-1",
        turn_index=1,
        message_event_id="message-1",
    )

    messages = service.message_event_service.get_display_messages(session.id)

    assert messages[0]["content"] == "拆 issues"
    assert messages[0]["clientInputId"] == "client-input-skill-1"
    item = messages[0]["contextItems"][0]
    assert item["type"] == "skill"
    assert item["label"] == "/dev-plan"
    assert item["skill_name"] == "dev-plan"
    assert item["source"] == "workspace"
    assert item["description"] == "Build a structured development plan."
    assert item["id"] == "skill:workspace:dev-plan"
    assert item["locator"] == ".keydex/skills/dev-plan/SKILL.md"
    assert item["origin"] == "slash"
    assert item["metadata"]["source"] == "workspace"
    assert item["metadata"]["locator"] == ".keydex/skills/dev-plan/SKILL.md"
    assert item["metadata"]["origin"] == "slash"
    assert "This body must not be stored" not in str(item)
