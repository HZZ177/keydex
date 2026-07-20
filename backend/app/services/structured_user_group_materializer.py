from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage

from backend.app.agent.context_compression_utils import stringify_message_content
from backend.app.agent.state import (
    build_pending_tool_call_preset_update,
    build_structured_user_group_replay_marker_update,
    build_structured_user_message_groups_update,
)
from backend.app.agent.tool_call_preset import ToolCallPreset, ToolCallPresetItem
from backend.app.services.structured_user_message_group import (
    StructuredUserMessageGroup,
    StructuredUserMessageMember,
)
from backend.app.storage import StorageRepositories

AttachmentResolver = Callable[[dict[str, Any]], list[dict[str, Any]]]
SkillValidator = Callable[[dict[str, Any]], None]


class StructuredUserGroupMaterializationError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class MaterializedStructuredUserGroups:
    boundary_id: str
    selected_group_ids: tuple[str, ...]
    messages: tuple[BaseMessage, ...]
    attachment_descriptors: tuple[dict[str, Any], ...]
    context_items: tuple[dict[str, Any], ...]
    thread_task_contexts: tuple[dict[str, Any], ...]
    state_update: dict[str, Any]
    visible_fingerprints: tuple[str, ...]


class StructuredUserGroupMaterializer:
    """Materialize only explicitly authorized, complete groups as one transaction."""

    def materialize(
        self,
        *,
        groups: Iterable[StructuredUserMessageGroup | dict[str, Any]],
        selected_group_ids: Iterable[str],
        boundary_id: str,
        tail_message_ids: Iterable[str] = (),
        tail_messages: Iterable[BaseMessage] = (),
        consumed_marker_keys: Iterable[str] = (),
        skill_validator: SkillValidator | None = None,
        attachment_resolver: AttachmentResolver | None = None,
    ) -> MaterializedStructuredUserGroups:
        selected_ids = tuple(dict.fromkeys(str(item) for item in selected_group_ids))
        if not selected_ids:
            return MaterializedStructuredUserGroups(
                boundary_id=boundary_id,
                selected_group_ids=(),
                messages=(),
                attachment_descriptors=(),
                context_items=(),
                thread_task_contexts=(),
                state_update={
                    **build_structured_user_message_groups_update([], replace=True),
                    **build_pending_tool_call_preset_update(None),
                },
                visible_fingerprints=(),
            )

        by_id: dict[str, StructuredUserMessageGroup] = {}
        for raw in groups:
            try:
                group = raw if isinstance(raw, StructuredUserMessageGroup) else (
                    StructuredUserMessageGroup.from_dict(raw)
                )
            except (TypeError, ValueError) as exc:
                raise StructuredUserGroupMaterializationError(
                    "invalid_group", "结构化用户消息组无效"
                ) from exc
            by_id[group.group_id] = group

        selected: list[StructuredUserMessageGroup] = []
        for group_id in selected_ids:
            group = by_id.get(group_id)
            if group is None:
                raise StructuredUserGroupMaterializationError(
                    "selected_group_missing", f"selected group 不存在: {group_id}"
                )
            if not group.is_authorizable:
                raise StructuredUserGroupMaterializationError(
                    "selected_group_incomplete", f"selected group 不完整: {group_id}"
                )
            selected.append(group)

        tail_ids = {str(item) for item in tail_message_ids}
        tail_semantic_keys = {
            key
            for message in tail_messages
            if (key := _message_semantic_key(message))[1]
        }
        consumed = {str(item) for item in consumed_marker_keys}
        skill_members: list[tuple[str, StructuredUserMessageMember]] = []
        attachment_members: list[tuple[str, StructuredUserMessageMember]] = []
        for group in selected:
            for member in group.ordered_members:
                if member.member_kind == "skill_activation":
                    if skill_validator is not None:
                        skill_validator(dict(member.payload))
                    skill_members.append((group.group_id, member))
                elif member.member_kind in {"attachment", "image_attachment"}:
                    attachment_members.append((group.group_id, member))

        resolved_attachments: dict[str, list[dict[str, Any]]] = {}
        if attachment_members:
            if attachment_resolver is None:
                raise StructuredUserGroupMaterializationError(
                    "attachment_resolver_missing",
                    "selected group 包含附件但没有当前附件校验器",
                )
            try:
                for _group_id, member in attachment_members:
                    resolved_attachments[member.fingerprint] = attachment_resolver(
                        dict(member.payload)
                    )
            except Exception as exc:
                raise StructuredUserGroupMaterializationError(
                    "attachment_resolution_failed", "附件重新校验失败"
                ) from exc

        messages: list[BaseMessage] = []
        contexts: list[dict[str, Any]] = []
        tasks: list[dict[str, Any]] = []
        visible_fingerprints: list[str] = []
        seen_fingerprints: set[str] = set()
        for group in selected:
            root_blocks: list[dict[str, Any]] = []
            for member in group.ordered_members:
                if member.member_kind in {"attachment", "image_attachment"}:
                    root_blocks.extend(resolved_attachments.get(member.fingerprint, []))
            for member in group.ordered_members:
                if member.fingerprint in seen_fingerprints:
                    continue
                seen_fingerprints.add(member.fingerprint)
                if member.member_kind == "message_context_item":
                    contexts.append(dict(member.payload))
                elif member.member_kind == "thread_task_context":
                    tasks.append(dict(member.payload))
                if member.member_kind not in {
                    "root_user_message",
                    "message_injection_follow",
                    "message_injection_slot",
                }:
                    continue
                source_id = str(member.source_id or member.payload.get("message_id") or "")
                if source_id and source_id in tail_ids:
                    continue
                member_semantic_key = _member_semantic_key(member)
                if member_semantic_key[1] and member_semantic_key in tail_semantic_keys:
                    continue
                message = _materialize_visible_member(
                    member,
                    group=group,
                    boundary_id=boundary_id,
                    root_attachment_blocks=root_blocks,
                )
                messages.append(message)
                visible_fingerprints.append(member.fingerprint)

        preset_calls: list[ToolCallPresetItem] = []
        preset_group_ids: list[str] = []
        for group_id, member in skill_members:
            marker_key = f"{boundary_id}:{group_id}:{member.fingerprint}"
            if marker_key in consumed:
                continue
            preset_group_ids.append(group_id)
            preset_calls.append(
                ToolCallPresetItem(
                    name="load_skill",
                    args={
                        "skill_name": member.payload["skill_name"],
                        "source": member.payload["source"],
                    },
                )
            )
        preset = (
            ToolCallPreset(
                type="force",
                producer="skill_activation",
                calls=preset_calls,
                metadata={
                    "source": "context_compression",
                    "boundary_id": boundary_id,
                    "selected_group_ids": list(dict.fromkeys(preset_group_ids)),
                },
            )
            if preset_calls
            else None
        )
        state_update = {
            **build_structured_user_message_groups_update(
                [group.to_dict() for group in selected], replace=True
            ),
            **build_structured_user_group_replay_marker_update(
                boundary_id=boundary_id,
                group_ids=[group.group_id for group in selected],
            ),
            **build_pending_tool_call_preset_update(preset.to_dict() if preset else None),
        }
        return MaterializedStructuredUserGroups(
            boundary_id=boundary_id,
            selected_group_ids=selected_ids,
            messages=tuple(messages),
            attachment_descriptors=tuple(
                dict(member.payload) for _group_id, member in attachment_members
            ),
            context_items=tuple(contexts),
            thread_task_contexts=tuple(tasks),
            state_update=state_update,
            visible_fingerprints=tuple(visible_fingerprints),
        )


def build_current_attachment_resolver(
    repositories: StorageRepositories,
    *,
    session_id: str,
    user_id: str,
) -> AttachmentResolver:
    """Reuse the normal claim/ownership/existence/type/size checks on every replay."""

    from backend.app.services.chat_message_payload import (
        attachment_data_url,
        resolve_image_attachments,
    )

    def resolve(descriptor: dict[str, Any]) -> list[dict[str, Any]]:
        records, _payloads = resolve_image_attachments(
            repositories,
            [descriptor],
            session_id=session_id,
            user_id=user_id,
        )
        return [
            {
                "type": "image_url",
                "image_url": {"url": attachment_data_url(record)},
            }
            for record in records
        ]

    return resolve


def _materialize_visible_member(
    member: StructuredUserMessageMember,
    *,
    group: StructuredUserMessageGroup,
    boundary_id: str,
    root_attachment_blocks: list[dict[str, Any]],
) -> BaseMessage:
    payload = member.payload
    content: Any = payload.get("content", "")
    if member.member_kind == "root_user_message" and root_attachment_blocks:
        content = [{"type": "text", "text": str(content)}, *root_attachment_blocks]
    role = str(payload.get("role") or "HumanMessage").casefold()
    additional_kwargs = {
        "_injected": member.member_kind != "root_user_message",
        "keydex_structured_user_group": {
            "boundary_id": boundary_id,
            "group_id": group.group_id,
            "group_fingerprint": group.fingerprint,
            "member_fingerprint": member.fingerprint,
            "member_kind": member.member_kind,
        },
        "hidden_for_transcript": bool(payload.get("hidden_for_transcript", False)),
    }
    message_id = str(member.source_id or payload.get("message_id") or "") or None
    if role in {"system", "systemmessage"}:
        return SystemMessage(id=message_id, content=content, additional_kwargs=additional_kwargs)
    if role in {"assistant", "ai", "aimessage"}:
        return AIMessage(id=message_id, content=content, additional_kwargs=additional_kwargs)
    return HumanMessage(id=message_id, content=content, additional_kwargs=additional_kwargs)


def _member_semantic_key(member: StructuredUserMessageMember) -> tuple[str, str]:
    role = str(member.payload.get("role") or "HumanMessage").casefold()
    return _normalized_role(role), str(member.payload.get("content") or "").strip()


def _message_semantic_key(message: BaseMessage) -> tuple[str, str]:
    if isinstance(message, SystemMessage):
        role = "system"
    elif isinstance(message, AIMessage):
        role = "assistant"
    else:
        role = "user"
    return role, stringify_message_content(getattr(message, "content", "")).strip()


def _normalized_role(role: str) -> str:
    if role in {"system", "systemmessage"}:
        return "system"
    if role in {"assistant", "ai", "aimessage"}:
        return "assistant"
    return "user"
