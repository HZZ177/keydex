from __future__ import annotations

import hashlib
import json
import math
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, TypeAlias

STRUCTURED_USER_MESSAGE_GROUP_SCHEMA_VERSION = 1

StructuredUserMessageMemberKind: TypeAlias = Literal[
    "message_injection_follow",
    "message_injection_slot",
    "root_user_message",
    "message_context_item",
    "skill_activation",
    "attachment",
    "image_attachment",
    "thread_task_context",
    "pending_user_input_context",
]
StructuredUserMessageGroupCompleteness: TypeAlias = Literal["complete", "incomplete"]

_MEMBER_KINDS = frozenset(
    {
        "message_injection_follow",
        "message_injection_slot",
        "root_user_message",
        "message_context_item",
        "skill_activation",
        "attachment",
        "image_attachment",
        "thread_task_context",
        "pending_user_input_context",
    }
)

_PAYLOAD_FIELDS: dict[str, frozenset[str]] = {
    "message_injection_follow": frozenset(
        {"type", "role", "content", "message_time", "metadata", "hidden_for_transcript"}
    ),
    "message_injection_slot": frozenset(
        {"type", "role", "content", "message_time", "metadata", "hidden_for_transcript"}
    ),
    "root_user_message": frozenset(
        {"content", "message_id", "role", "metadata", "hidden_for_transcript"}
    ),
    "message_context_item": frozenset(
        {
            "id",
            "type",
            "label",
            "content",
            "role",
            "source",
            "metadata",
            "path",
            "name",
            "file_type",
            "skill_name",
            "description",
            "locator",
        }
    ),
    "skill_activation": frozenset({"skill_name", "source", "origin"}),
    "attachment": frozenset(
        {"attachment_id", "id", "type", "source", "name", "mime_type", "size", "order"}
    ),
    "image_attachment": frozenset(
        {"attachment_id", "id", "type", "source", "name", "mime_type", "size", "order"}
    ),
    "thread_task_context": frozenset({"task_id", "run_id", "trigger", "type"}),
    "pending_user_input_context": frozenset(
        {"pending_input_id", "client_input_id", "delivery_mode", "status"}
    ),
}

_FORBIDDEN_NESTED_KEYS = frozenset(
    {
        "runtime_params",
        "runtimeParams",
        "provider_id",
        "providerId",
        "model",
        "retry",
        "trace_control",
        "traceControl",
        "ui_state",
        "uiState",
        "skill_body",
        "skillBody",
        "skill_content",
        "skillContent",
    }
)
_VOLATILE_FINGERPRINT_KEYS = frozenset(
    {
        "message_time",
        "messageTime",
        "timestamp",
        "created_at",
        "createdAt",
        "updated_at",
        "updatedAt",
    }
)


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _fingerprint(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _fingerprint_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            key: _fingerprint_value(child)
            for key, child in value.items()
            if key not in _VOLATILE_FINGERPRINT_KEYS
        }
    if isinstance(value, list):
        return [_fingerprint_value(child) for child in value]
    return value


def _normalize_json(value: Any, *, path: str = "payload") -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"{path} 不能包含非有限浮点数")
        return value
    if isinstance(value, Mapping):
        normalized: dict[str, Any] = {}
        for raw_key, child in value.items():
            if not isinstance(raw_key, str):
                raise ValueError(f"{path} 的键必须是字符串")
            if raw_key in _FORBIDDEN_NESTED_KEYS:
                raise ValueError(f"{path}.{raw_key} 不允许进入用户消息组")
            normalized[raw_key] = _normalize_json(child, path=f"{path}.{raw_key}")
        return normalized
    if isinstance(value, (list, tuple)):
        return [
            _normalize_json(child, path=f"{path}[{index}]")
            for index, child in enumerate(value)
        ]
    raise ValueError(f"{path} 必须是可序列化的 JSON 值")


def _normalize_payload(member_kind: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    if member_kind not in _MEMBER_KINDS:
        raise ValueError(f"不支持的结构化用户消息成员类型: {member_kind}")
    if not isinstance(payload, Mapping):
        raise ValueError("member payload 必须是对象")
    unknown = set(payload) - _PAYLOAD_FIELDS[member_kind]
    if unknown:
        names = ", ".join(sorted(str(item) for item in unknown))
        raise ValueError(f"{member_kind} payload 包含未授权字段: {names}")
    normalized = _normalize_json(payload)
    if member_kind == "root_user_message" and "content" not in normalized:
        raise ValueError("root_user_message payload.content 必须存在")
    if member_kind == "skill_activation":
        skill_name = str(normalized.get("skill_name") or "").strip()
        if not skill_name:
            raise ValueError("skill_activation payload.skill_name 不能为空")
        normalized["skill_name"] = skill_name
        source = str(normalized.get("source") or "workspace").strip() or "workspace"
        if source not in {"builtin", "system", "workspace"}:
            raise ValueError("skill_activation payload.source 不受支持")
        normalized["source"] = source
    if member_kind in {"attachment", "image_attachment"}:
        attachment_id = str(
            normalized.get("attachment_id") or normalized.get("id") or ""
        ).strip()
        if not attachment_id:
            raise ValueError(f"{member_kind} payload.attachment_id 不能为空")
        normalized["attachment_id"] = attachment_id
        normalized.pop("id", None)
    return normalized


@dataclass(frozen=True, slots=True)
class StructuredUserMessageMember:
    member_kind: StructuredUserMessageMemberKind
    member_order: int
    payload: dict[str, Any]
    fingerprint: str = ""
    source_id: str | None = None

    def __post_init__(self) -> None:
        if self.member_kind not in _MEMBER_KINDS:
            raise ValueError(f"不支持的结构化用户消息成员类型: {self.member_kind}")
        if not isinstance(self.member_order, int) or self.member_order < 0:
            raise ValueError("member_order 必须是非负整数")
        normalized = _normalize_payload(self.member_kind, self.payload)
        expected = _fingerprint(
            {
                "member_kind": self.member_kind,
                "member_order": self.member_order,
                "payload": _fingerprint_value(normalized),
                "source_id": self.source_id,
            }
        )
        if self.fingerprint and self.fingerprint != expected:
            raise ValueError("member fingerprint 与 payload 不一致")
        object.__setattr__(self, "payload", normalized)
        object.__setattr__(self, "fingerprint", expected)

    def to_dict(self) -> dict[str, Any]:
        return {
            "member_kind": self.member_kind,
            "member_order": self.member_order,
            "payload": _normalize_json(self.payload),
            "fingerprint": self.fingerprint,
            "source_id": self.source_id,
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> StructuredUserMessageMember:
        if not isinstance(raw, Mapping):
            raise ValueError("structured user message member 必须是对象")
        return cls(
            member_kind=str(raw.get("member_kind") or ""),  # type: ignore[arg-type]
            member_order=int(raw.get("member_order", -1)),
            payload=dict(raw.get("payload") or {}),
            fingerprint=str(raw.get("fingerprint") or ""),
            source_id=str(raw["source_id"]) if raw.get("source_id") is not None else None,
        )


@dataclass(frozen=True, slots=True)
class StructuredUserMessageGroup:
    group_id: str
    root_user_message: StructuredUserMessageMember
    members: tuple[StructuredUserMessageMember, ...] = field(default_factory=tuple)
    completeness: StructuredUserMessageGroupCompleteness = "complete"
    incomplete_reasons: tuple[str, ...] = field(default_factory=tuple)
    source_session_id: str | None = None
    trace_id: str | None = None
    turn_index: int | None = None
    message_event_id: str | None = None
    fingerprint: str = ""
    schema_version: int = STRUCTURED_USER_MESSAGE_GROUP_SCHEMA_VERSION

    def __post_init__(self) -> None:
        group_id = str(self.group_id or "").strip()
        if not group_id:
            raise ValueError("group_id 不能为空")
        if self.schema_version != STRUCTURED_USER_MESSAGE_GROUP_SCHEMA_VERSION:
            raise ValueError(
                f"不支持的 structured user message group schema: {self.schema_version}"
            )
        if self.root_user_message.member_kind != "root_user_message":
            raise ValueError("root_user_message 的 member_kind 必须为 root_user_message")
        if self.completeness not in {"complete", "incomplete"}:
            raise ValueError("completeness 必须为 complete 或 incomplete")
        reasons = tuple(str(item).strip() for item in self.incomplete_reasons if str(item).strip())
        if self.completeness == "complete" and reasons:
            raise ValueError("complete group 不能包含 incomplete_reasons")
        if self.completeness == "incomplete" and not reasons:
            raise ValueError("incomplete group 必须说明 incomplete_reasons")
        ordered = (self.root_user_message, *tuple(self.members))
        orders = [item.member_order for item in ordered]
        if len(orders) != len(set(orders)):
            raise ValueError("同一 group 的 member_order 不能重复")
        if any(item.member_kind == "root_user_message" for item in self.members):
            raise ValueError("members 不能重复包含 root_user_message")
        expected = _fingerprint(
            {
                "schema_version": self.schema_version,
                "completeness": self.completeness,
                "incomplete_reasons": list(reasons),
                "members": [
                    item.fingerprint
                    for item in sorted(ordered, key=lambda item: item.member_order)
                ],
            }
        )
        if self.fingerprint and self.fingerprint != expected:
            raise ValueError("group fingerprint 与成员不一致")
        object.__setattr__(self, "group_id", group_id)
        object.__setattr__(self, "members", tuple(self.members))
        object.__setattr__(self, "incomplete_reasons", reasons)
        object.__setattr__(self, "fingerprint", expected)

    @property
    def ordered_members(self) -> tuple[StructuredUserMessageMember, ...]:
        return tuple(
            sorted((self.root_user_message, *self.members), key=lambda item: item.member_order)
        )

    @property
    def is_authorizable(self) -> bool:
        return self.completeness == "complete"

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "group_id": self.group_id,
            "root_user_message": self.root_user_message.to_dict(),
            "members": [item.to_dict() for item in self.members],
            "completeness": self.completeness,
            "incomplete_reasons": list(self.incomplete_reasons),
            "source_session_id": self.source_session_id,
            "trace_id": self.trace_id,
            "turn_index": self.turn_index,
            "message_event_id": self.message_event_id,
            "fingerprint": self.fingerprint,
        }

    @classmethod
    def create(
        cls,
        *,
        root_user_message: StructuredUserMessageMember,
        members: Sequence[StructuredUserMessageMember] = (),
        group_id: str | None = None,
        completeness: StructuredUserMessageGroupCompleteness = "complete",
        incomplete_reasons: Sequence[str] = (),
        source_session_id: str | None = None,
        trace_id: str | None = None,
        turn_index: int | None = None,
        message_event_id: str | None = None,
    ) -> StructuredUserMessageGroup:
        return cls(
            group_id=group_id or f"sug-{uuid.uuid4().hex}",
            root_user_message=root_user_message,
            members=tuple(members),
            completeness=completeness,
            incomplete_reasons=tuple(incomplete_reasons),
            source_session_id=source_session_id,
            trace_id=trace_id,
            turn_index=turn_index,
            message_event_id=message_event_id,
        )

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> StructuredUserMessageGroup:
        if not isinstance(raw, Mapping):
            raise ValueError("structured user message group 必须是对象")
        raw_root = raw.get("root_user_message")
        if not isinstance(raw_root, Mapping):
            raise ValueError("root_user_message 必须是对象")
        raw_members = raw.get("members") or []
        if not isinstance(raw_members, list):
            raise ValueError("members 必须是数组")
        return cls(
            schema_version=int(
                raw.get("schema_version", STRUCTURED_USER_MESSAGE_GROUP_SCHEMA_VERSION)
            ),
            group_id=str(raw.get("group_id") or ""),
            root_user_message=StructuredUserMessageMember.from_dict(raw_root),
            members=tuple(StructuredUserMessageMember.from_dict(item) for item in raw_members),
            completeness=str(raw.get("completeness") or "complete"),  # type: ignore[arg-type]
            incomplete_reasons=tuple(raw.get("incomplete_reasons") or ()),
            source_session_id=(
                str(raw["source_session_id"])
                if raw.get("source_session_id") is not None
                else None
            ),
            trace_id=str(raw["trace_id"]) if raw.get("trace_id") is not None else None,
            turn_index=int(raw["turn_index"]) if raw.get("turn_index") is not None else None,
            message_event_id=(
                str(raw["message_event_id"])
                if raw.get("message_event_id") is not None
                else None
            ),
            fingerprint=str(raw.get("fingerprint") or ""),
        )


def build_structured_user_message_member(
    member_kind: StructuredUserMessageMemberKind,
    member_order: int,
    payload: Mapping[str, Any],
    *,
    source_id: str | None = None,
) -> StructuredUserMessageMember:
    return StructuredUserMessageMember(
        member_kind=member_kind,
        member_order=member_order,
        payload=dict(payload),
        source_id=source_id,
    )
