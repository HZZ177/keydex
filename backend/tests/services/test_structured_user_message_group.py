from __future__ import annotations

import copy

import pytest

from backend.app.services.chat_service import (
    InjectedMessage,
    MessageInjectionRole,
    MessageInjectionType,
    SkillActivationRequest,
    _build_structured_user_message_group,
)
from backend.app.services.chat_types import ChatRequest
from backend.app.services.structured_user_message_group import (
    StructuredUserMessageGroup,
    StructuredUserMessageMember,
    build_structured_user_message_member,
)


def _root(order: int = 1) -> StructuredUserMessageMember:
    return build_structured_user_message_member(
        "root_user_message",
        order,
        {"content": "完成压缩设计", "role": "HumanMessage"},
        source_id="msg-user-1",
    )


def test_group_round_trip_preserves_member_order_and_source_refs() -> None:
    injection = build_structured_user_message_member(
        "message_injection_follow",
        0,
        {
            "type": "follow",
            "role": "HumanMessage",
            "content": "引用：只修改目标文件",
            "metadata": {"source": "selection"},
            "hidden_for_transcript": True,
        },
    )
    activation = build_structured_user_message_member(
        "skill_activation",
        2,
        {"skill_name": "dev-plan-execute", "source": "workspace", "origin": "slash"},
    )
    attachment = build_structured_user_message_member(
        "image_attachment",
        3,
        {
            "attachment_id": "att-1",
            "type": "image",
            "name": "design.png",
            "mime_type": "image/png",
            "size": 128,
        },
    )
    group = StructuredUserMessageGroup.create(
        group_id="group-1",
        root_user_message=_root(),
        members=[activation, injection, attachment],
        source_session_id="session-1",
        trace_id="trace-1",
        turn_index=4,
        message_event_id="event-1",
    )

    restored = StructuredUserMessageGroup.from_dict(group.to_dict())

    assert restored == group
    assert [item.member_order for item in restored.ordered_members] == [0, 1, 2, 3]
    assert restored.is_authorizable is True
    assert restored.trace_id == "trace-1"


def test_fingerprints_are_stable_and_do_not_depend_on_group_id() -> None:
    member_a = _root()
    member_b = _root()
    assert member_a.fingerprint == member_b.fingerprint

    group_a = StructuredUserMessageGroup.create(
        group_id="group-a",
        root_user_message=member_a,
        trace_id="trace-a",
    )
    group_b = StructuredUserMessageGroup.create(
        group_id="group-b",
        root_user_message=member_b,
        trace_id="trace-b",
    )
    assert group_a.fingerprint == group_b.fingerprint


def test_member_fingerprint_ignores_volatile_message_timestamps() -> None:
    first = build_structured_user_message_member(
        "message_injection_follow",
        0,
        {
            "type": "follow",
            "role": "HumanMessage",
            "content": "same",
            "message_time": "2026-07-17T01:00:00Z",
            "metadata": {"created_at": "one", "source": "selection"},
        },
    )
    second = build_structured_user_message_member(
        "message_injection_follow",
        0,
        {
            "type": "follow",
            "role": "HumanMessage",
            "content": "same",
            "message_time": "2026-07-17T02:00:00Z",
            "metadata": {"created_at": "two", "source": "selection"},
        },
    )
    assert first.fingerprint == second.fingerprint


def test_incomplete_group_requires_reason_and_cannot_authorize_replay() -> None:
    group = StructuredUserMessageGroup.create(
        root_user_message=_root(),
        completeness="incomplete",
        incomplete_reasons=["missing_skill_activation"],
    )
    assert group.is_authorizable is False

    with pytest.raises(ValueError, match="incomplete_reasons"):
        StructuredUserMessageGroup.create(
            root_user_message=_root(),
            completeness="incomplete",
        )


@pytest.mark.parametrize(
    ("kind", "payload"),
    [
        ("skill_activation", {"skill_name": "dev-plan", "skill_body": "secret"}),
        ("root_user_message", {"content": "hello", "provider_id": "provider"}),
        ("attachment", {"attachment_id": "att", "path": "C:/unsafe"}),
        ("thread_task_context", {"task_id": "task", "runtime_params": {}}),
    ],
)
def test_member_payload_rejects_non_whitelisted_runtime_fields(
    kind: str,
    payload: dict[str, object],
) -> None:
    with pytest.raises(ValueError, match="未授权字段|不允许"):
        StructuredUserMessageMember(  # type: ignore[arg-type]
            member_kind=kind,
            member_order=0,
            payload=payload,
        )


def test_round_trip_rejects_tampered_member_and_group_fingerprints() -> None:
    group = StructuredUserMessageGroup.create(root_user_message=_root())

    tampered_member = copy.deepcopy(group.to_dict())
    tampered_member["root_user_message"]["payload"]["content"] = "changed"
    with pytest.raises(ValueError, match="member fingerprint"):
        StructuredUserMessageGroup.from_dict(tampered_member)

    tampered_group = copy.deepcopy(group.to_dict())
    tampered_group["fingerprint"] = "0" * 64
    with pytest.raises(ValueError, match="group fingerprint"):
        StructuredUserMessageGroup.from_dict(tampered_group)


def test_duplicate_member_order_and_second_root_are_rejected() -> None:
    with pytest.raises(ValueError, match="member_order"):
        StructuredUserMessageGroup.create(
            root_user_message=_root(0),
            members=[
                build_structured_user_message_member(
                    "message_context_item",
                    0,
                    {"id": "ctx", "type": "follow", "content": "context"},
                )
            ],
        )

    with pytest.raises(ValueError, match="重复包含"):
        StructuredUserMessageGroup.create(
            root_user_message=_root(0),
            members=[_root(1)],
        )


def test_chat_request_group_captures_all_normalized_structured_inputs() -> None:
    request = ChatRequest(
        message="按引用继续实现",
        session_id="session-1",
        user_id="user-1",
        runtime_params={"message_injection": []},
        attachments=[{"attachment_id": "att-1"}],
    )
    injections = [
        InjectedMessage(
            type=MessageInjectionType.SLOT,
            role=MessageInjectionRole.SYSTEM,
            content="项目固定约束",
        ),
        InjectedMessage(
            type=MessageInjectionType.FOLLOW,
            role=MessageInjectionRole.HUMAN,
            content="引用原文",
            metadata={"source": "selection"},
            hidden_for_transcript=True,
        ),
    ]
    context_items = [
        {
            "id": "ctx-1",
            "type": "quote",
            "label": "引用",
            "content": "引用原文",
            "role": "HumanMessage",
            "source": "runtime",
            "metadata": {"comment": "注意这里"},
            "fileType": "python",
            "skillName": "dev-plan",
        }
    ]

    group = _build_structured_user_message_group(
        request=request,
        message_injection=injections,
        message_context_items=context_items,
        skill_activation=SkillActivationRequest(
            skill_name="dev-plan-execute",
            source="workspace",
            origin="slash",
        ),
        attachment_payloads=[
            {
                "attachment_id": "att-1",
                "id": "att-1",
                "type": "image",
                "source": "upload",
                "name": "input.png",
                "path": "D:/private/not-persisted.png",
                "mime_type": "image/png",
                "size": 42,
            }
        ],
        thread_task_context=None,
        session_id="session-1",
        trace_id="trace-1",
        turn_index=7,
        message_event_id="event-1",
    )

    kinds = [item.member_kind for item in group.ordered_members]
    assert kinds == [
        "message_injection_slot",
        "message_injection_follow",
        "skill_activation",
        "message_context_item",
        "root_user_message",
        "image_attachment",
    ]
    assert {item.member_order for item in group.ordered_members} == set(range(6))
    assert group.root_user_message.payload["content"] == "按引用继续实现"
    attachment = group.ordered_members[-1]
    assert attachment.payload["attachment_id"] == "att-1"
    assert "path" not in attachment.payload
    context = group.ordered_members[3]
    assert context.payload["file_type"] == "python"
    assert context.payload["skill_name"] == "dev-plan"


def test_chat_request_group_allows_empty_root_with_hidden_injection() -> None:
    request = ChatRequest(message="", runtime_params={"message_injection": []})
    group = _build_structured_user_message_group(
        request=request,
        message_injection=[
            InjectedMessage(
                type=MessageInjectionType.FOLLOW,
                role=MessageInjectionRole.HUMAN,
                content="隐藏任务上下文",
                hidden_for_transcript=True,
            )
        ],
        message_context_items=[],
        skill_activation=None,
        attachment_payloads=[],
        thread_task_context={
            "task_id": "goal-1",
            "run_id": "run-1",
            "trigger": "task_continue",
            "type": "goal",
        },
        session_id="session-1",
        trace_id="trace-hidden",
        turn_index=1,
        message_event_id="event-hidden",
    )
    assert group.root_user_message.payload["content"] == ""
    assert group.root_user_message.payload["hidden_for_transcript"] is True
    assert group.ordered_members[0].member_kind == "thread_task_context"
    assert group.ordered_members[0].payload["run_id"] == "run-1"
