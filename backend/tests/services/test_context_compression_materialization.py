from __future__ import annotations

import pytest
from langchain_core.messages import HumanMessage, SystemMessage

from backend.app.services import chat_message_payload
from backend.app.services.structured_user_group_materializer import (
    StructuredUserGroupMaterializationError,
    StructuredUserGroupMaterializer,
    build_current_attachment_resolver,
)
from backend.app.services.structured_user_message_group import (
    StructuredUserMessageGroup,
    build_structured_user_message_member,
)
from backend.app.storage import StorageRepositories, init_database


def _mixed_group(
    group_id: str = "g1", *, complete: bool = True
) -> StructuredUserMessageGroup:
    members = [
        build_structured_user_message_member(
            "message_injection_slot",
            0,
            {
                "type": "slot",
                "role": "SystemMessage",
                "content": "项目注入",
                "hidden_for_transcript": True,
                "metadata": {"kind": "quote"},
            },
            source_id="slot-1",
        ),
        build_structured_user_message_member(
            "message_context_item",
            1,
            {
                "id": "ctx-1",
                "type": "comment",
                "label": "评论",
                "content": "这里要修",
                "role": "HumanMessage",
                "source": "composer",
                "metadata": {"line": 4},
            },
            source_id="ctx-1",
        ),
        build_structured_user_message_member(
            "skill_activation",
            3,
            {"skill_name": "dev-plan", "source": "workspace", "origin": "composer"},
        ),
        build_structured_user_message_member(
            "image_attachment",
            4,
            {
                "attachment_id": "att-1",
                "type": "image",
                "name": "a.png",
                "mime_type": "image/png",
                "size": 100,
                "order": 0,
            },
        ),
        build_structured_user_message_member(
            "thread_task_context",
            5,
            {"task_id": "task-1", "run_id": "run-1", "trigger": "task_continue"},
        ),
    ]
    root = build_structured_user_message_member(
        "root_user_message",
        2,
        {"content": "继续执行", "message_id": "user-1", "role": "HumanMessage"},
        source_id="user-1",
    )
    return StructuredUserMessageGroup.create(
        group_id=group_id,
        root_user_message=root,
        members=members,
        completeness="complete" if complete else "incomplete",
        incomplete_reasons=() if complete else ("legacy_missing_members",),
    )


def test_materializer_restores_all_members_in_original_order_and_builds_skill_preset() -> None:
    validated: list[str] = []
    result = StructuredUserGroupMaterializer().materialize(
        groups=[_mixed_group()],
        selected_group_ids=["g1"],
        boundary_id="b1",
        skill_validator=lambda payload: validated.append(payload["skill_name"]),
        attachment_resolver=lambda descriptor: [
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:{descriptor['mime_type']};base64,eA=="
                },
            }
        ],
    )
    assert validated == ["dev-plan"]
    assert [type(message) for message in result.messages] == [
        SystemMessage,
        HumanMessage,
        HumanMessage,
    ]
    assert [str(message.content) for message in result.messages[:2]] == [
        "项目注入",
        "这里要修",
    ]
    assert isinstance(result.messages[2].content, list)
    assert result.context_items[0]["id"] == "ctx-1"
    assert result.thread_task_contexts[0]["task_id"] == "task-1"
    preset = result.state_update["pending_tool_call_preset"]
    assert preset["calls"] == [
        {
            "name": "load_skill",
            "args": {"skill_name": "dev-plan", "source": "workspace"},
        }
    ]
    assert preset["metadata"]["selected_group_ids"] == ["g1"]


def test_tail_dedupes_visible_message_but_keeps_full_structured_authorization() -> None:
    result = StructuredUserGroupMaterializer().materialize(
        groups=[_mixed_group()],
        selected_group_ids=["g1"],
        boundary_id="b1",
        tail_message_ids=["user-1", "slot-1"],
        attachment_resolver=lambda _descriptor: [],
    )
    assert [message.id for message in result.messages] == ["ctx-1"]
    assert result.selected_group_ids == ("g1",)
    assert result.state_update["structured_user_message_groups"]["groups"][0][
        "group_id"
    ] == "g1"
    assert result.state_update["pending_tool_call_preset"] is not None


@pytest.mark.parametrize("selected", [[], ["missing"]])
def test_unselected_or_missing_group_cannot_authorize_structured_side_effects(
    selected: list[str],
) -> None:
    materializer = StructuredUserGroupMaterializer()
    if not selected:
        result = materializer.materialize(
            groups=[_mixed_group()], selected_group_ids=selected, boundary_id="b1"
        )
        assert result.messages == ()
        assert result.state_update["pending_tool_call_preset"] is None
        return
    with pytest.raises(StructuredUserGroupMaterializationError) as error:
        materializer.materialize(
            groups=[_mixed_group()], selected_group_ids=selected, boundary_id="b1"
        )
    assert error.value.code == "selected_group_missing"


def test_incomplete_group_is_rejected_even_when_members_are_available() -> None:
    with pytest.raises(StructuredUserGroupMaterializationError) as error:
        StructuredUserGroupMaterializer().materialize(
            groups=[_mixed_group(complete=False)],
            selected_group_ids=["g1"],
            boundary_id="b1",
        )
    assert error.value.code == "selected_group_incomplete"


def test_attachment_failure_is_atomic_and_returns_no_partial_result() -> None:
    def reject_attachment(_descriptor):
        raise PermissionError("cross-session")

    with pytest.raises(StructuredUserGroupMaterializationError) as error:
        StructuredUserGroupMaterializer().materialize(
            groups=[_mixed_group()],
            selected_group_ids=["g1"],
            boundary_id="b1",
            attachment_resolver=reject_attachment,
        )
    assert error.value.code == "attachment_resolution_failed"


def test_same_boundary_consumed_skill_marker_prevents_duplicate_force_call() -> None:
    group = _mixed_group()
    skill = next(
        member for member in group.members if member.member_kind == "skill_activation"
    )
    result = StructuredUserGroupMaterializer().materialize(
        groups=[group],
        selected_group_ids=["g1"],
        boundary_id="b1",
        consumed_marker_keys=[f"b1:g1:{skill.fingerprint}"],
        attachment_resolver=lambda _descriptor: [],
    )
    assert result.state_update["pending_tool_call_preset"] is None


def test_current_attachment_resolver_revalidates_ownership_and_current_file(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="session-1",
        user_id="user-1",
        scene_id="desktop-agent",
        title="会话",
    )
    target = tmp_path / "a.png"
    target.write_bytes(b"png")
    repositories.attachments.create(
        attachment_id="att-1",
        user_id="user-1",
        session_id="session-1",
        type="image",
        source="upload",
        name="a.png",
        path=str(target),
        mime_type="image/png",
        size=target.stat().st_size,
    )
    resolver = build_current_attachment_resolver(
        repositories, session_id="session-1", user_id="user-1"
    )
    blocks = resolver({"attachment_id": "att-1"})
    assert blocks[0]["image_url"]["url"].startswith("data:image/png;base64,")
    target.unlink()
    with pytest.raises(ValueError, match="文件不存在"):
        resolver({"attachment_id": "att-1"})


def test_current_attachment_resolver_rejects_cross_session(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    for session_id in ("session-1", "session-2"):
        repositories.sessions.create(
            session_id=session_id,
            user_id="user-1",
            scene_id="desktop-agent",
            title="会话",
        )
    target = tmp_path / "a.png"
    target.write_bytes(b"png")
    repositories.attachments.create(
        attachment_id="att-1",
        user_id="user-1",
        session_id="session-1",
        type="image",
        source="upload",
        name="a.png",
        path=str(target),
        mime_type="image/png",
        size=target.stat().st_size,
    )
    resolver = build_current_attachment_resolver(
        repositories, session_id="session-2", user_id="user-1"
    )
    with pytest.raises(ValueError, match="当前会话"):
        resolver({"attachment_id": "att-1"})


@pytest.mark.parametrize(
    ("attachment_type", "expected_error"),
    [("file", "仅支持图片"), ("document", "仅支持图片")],
)
def test_current_attachment_resolver_rejects_non_image_types(
    tmp_path, attachment_type: str, expected_error: str
) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="session-1",
        user_id="user-1",
        scene_id="desktop-agent",
        title="会话",
    )
    target = tmp_path / "payload.bin"
    target.write_bytes(b"payload")
    repositories.attachments.create(
        attachment_id="att-1",
        user_id="user-1",
        session_id="session-1",
        type=attachment_type,
        source="upload",
        name=target.name,
        path=str(target),
        mime_type="application/octet-stream",
        size=target.stat().st_size,
    )
    resolver = build_current_attachment_resolver(
        repositories, session_id="session-1", user_id="user-1"
    )
    with pytest.raises(ValueError, match=expected_error):
        resolver({"attachment_id": "att-1"})


def test_current_attachment_resolver_rejects_current_oversized_file(
    tmp_path, monkeypatch
) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="session-1",
        user_id="user-1",
        scene_id="desktop-agent",
        title="会话",
    )
    target = tmp_path / "large.png"
    target.write_bytes(b"png")
    repositories.attachments.create(
        attachment_id="att-1",
        user_id="user-1",
        session_id="session-1",
        type="image",
        source="upload",
        name=target.name,
        path=str(target),
        mime_type="image/png",
        size=target.stat().st_size,
    )
    monkeypatch.setattr(chat_message_payload, "MAX_IMAGE_ATTACHMENT_BYTES", 2)
    resolver = build_current_attachment_resolver(
        repositories, session_id="session-1", user_id="user-1"
    )
    with pytest.raises(ValueError, match="图片附件过大"):
        resolver({"attachment_id": "att-1"})


def test_current_attachment_resolver_rejects_cross_user(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="session-1",
        user_id="user-1",
        scene_id="desktop-agent",
        title="会话",
    )
    target = tmp_path / "a.png"
    target.write_bytes(b"png")
    repositories.attachments.create(
        attachment_id="att-1",
        user_id="user-2",
        session_id="session-1",
        type="image",
        source="upload",
        name=target.name,
        path=str(target),
        mime_type="image/png",
        size=target.stat().st_size,
    )
    resolver = build_current_attachment_resolver(
        repositories, session_id="session-1", user_id="user-1"
    )
    with pytest.raises(ValueError, match="当前用户"):
        resolver({"attachment_id": "att-1"})
