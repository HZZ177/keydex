from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage

from backend.app.services.legacy_user_group_reconstructor import (
    LegacyUserGroupReconstructor,
)
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "legacy.db"))
    repositories.sessions.create(
        session_id="session-1",
        user_id="user-1",
        scene_id="desktop-agent",
    )
    return repositories


def test_reconstructs_complete_group_from_trace_runtime_params_and_user_event(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.trace_records.create(
        trace_id="trace-1",
        session_id="session-1",
        scene_id="desktop-agent",
        user_id="user-1",
        turn_index=1,
        root_node_id="trace-1-root",
        metadata={
            "runtime_params": {
                "message_injection": [
                    {
                        "type": "follow",
                        "role": "HumanMessage",
                        "content": "引用原文",
                    }
                ],
                "message_context_items": [
                    {"id": "context-1", "label": "引用", "content": "引用原文"}
                ],
                "skill_activation": {
                    "skill_name": "dev-plan",
                    "source": "workspace",
                },
            }
        },
    )
    repositories.message_events.append(
        event_id="event-1",
        session_id="session-1",
        trace_record_id="trace-1",
        turn_index=1,
        action="user_message",
        data={
            "content": "继续实现",
            "attachments": [
                {
                    "attachment_id": "att-1",
                    "type": "image",
                    "source": "upload",
                    "name": "input.png",
                    "mime_type": "image/png",
                    "size": 10,
                }
            ],
            "context_items": [],
        },
    )

    groups = LegacyUserGroupReconstructor(repositories).reconstruct_session("session-1")

    assert len(groups) == 1
    group = groups[0]
    assert group.is_authorizable is True
    assert group.trace_id == "trace-1"
    assert [item.member_kind for item in group.ordered_members] == [
        "message_injection_follow",
        "skill_activation",
        "message_context_item",
        "root_user_message",
        "image_attachment",
    ]


def test_missing_user_event_keeps_only_diagnostic_incomplete_group(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.trace_records.create(
        trace_id="trace-2",
        session_id="session-1",
        scene_id="desktop-agent",
        user_id="user-1",
        turn_index=2,
        root_node_id="trace-2-root",
        user_message_preview="preview only",
        metadata={},
    )

    groups = LegacyUserGroupReconstructor(repositories).reconstruct_session("session-1")

    assert len(groups) == 1
    assert groups[0].is_authorizable is False
    assert groups[0].incomplete_reasons == ("missing_user_message_event",)


def test_message_only_reconstruction_skips_new_and_old_compact_summaries(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    messages = [
        SystemMessage(content="<keydex_context_compression>old</keydex_context_compression>"),
        HumanMessage(
            content="synthetic",
            additional_kwargs={
                "keydex_context_compression": {"kind": "summary", "schema_version": 1}
            },
        ),
        HumanMessage(content="真实用户原文", id="human-1"),
    ]

    groups = LegacyUserGroupReconstructor(repositories).reconstruct_messages(
        messages,
        session_id="session-1",
    )

    assert len(groups) == 1
    assert groups[0].root_user_message.payload["content"] == "真实用户原文"
    assert groups[0].is_authorizable is False
    assert groups[0].incomplete_reasons == ("legacy_message_only",)


def test_existing_group_trace_is_not_reconstructed_twice(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.trace_records.create(
        trace_id="trace-3",
        session_id="session-1",
        scene_id="desktop-agent",
        user_id="user-1",
        turn_index=3,
        root_node_id="trace-3-root",
        user_message_preview="existing",
    )
    reconstructor = LegacyUserGroupReconstructor(repositories)
    existing = reconstructor.reconstruct_session("session-1")[0]

    assert reconstructor.reconstruct_session("session-1", existing_groups=[existing]) == []
