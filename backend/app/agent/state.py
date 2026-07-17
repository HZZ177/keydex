from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated, Any

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages
from typing_extensions import TypedDict

PENDING_SKILL_ACTIVATIONS_RESET_MARKER = "__keydex_pending_skill_activations_reset__"
PENDING_TOOL_CALL_PRESET_STATE_KEY = "pending_tool_call_preset"
STRUCTURED_USER_MESSAGE_GROUPS_STATE_KEY = "structured_user_message_groups"
STRUCTURED_USER_GROUP_REPLAY_MARKERS_STATE_KEY = "structured_user_group_replay_markers"
CONTEXT_COMPRESSION_DIAGNOSTICS_STATE_KEY = "context_compression_diagnostics"


def merge_pending_skill_activations(left: Any, right: Any) -> list[dict[str, Any]]:
    left_list = list(left or [])
    right_list = list(right or [])
    if len(right_list) == 1 and right_list[0] == PENDING_SKILL_ACTIVATIONS_RESET_MARKER:
        return []
    if not right_list:
        return left_list
    return left_list + right_list


def build_pending_skill_activations_reset_update() -> dict[str, list[str]]:
    return {
        "pending_skill_activations": [PENDING_SKILL_ACTIVATIONS_RESET_MARKER],
    }


def build_pending_tool_call_preset_update(
    preset: dict[str, Any] | None,
) -> dict[str, dict[str, Any] | None]:
    return {PENDING_TOOL_CALL_PRESET_STATE_KEY: dict(preset) if preset is not None else None}


def merge_structured_user_message_groups(left: Any, right: Any) -> list[dict[str, Any]]:
    from backend.app.services.structured_user_message_group import StructuredUserMessageGroup

    left_groups = list(left or [])
    mode = "append"
    if isinstance(right, Mapping):
        mode = str(right.get("mode") or "append")
        right_groups = list(right.get("groups") or [])
    else:
        right_groups = list(right or [])
    if mode == "reset":
        return []
    if mode == "replace":
        left_groups = []
    elif mode != "append":
        raise ValueError(f"unsupported structured user group merge mode: {mode}")

    normalized: list[dict[str, Any]] = []
    positions: dict[str, int] = {}
    for raw in [*left_groups, *right_groups]:
        group = StructuredUserMessageGroup.from_dict(raw)
        payload = group.to_dict()
        existing = positions.get(group.group_id)
        if existing is None:
            positions[group.group_id] = len(normalized)
            normalized.append(payload)
        elif normalized[existing]["fingerprint"] != group.fingerprint:
            normalized[existing] = payload
    return normalized


def build_structured_user_message_groups_update(
    groups: list[dict[str, Any]],
    *,
    replace: bool = False,
) -> dict[str, Any]:
    normalized = [dict(group) for group in groups]
    return {
        STRUCTURED_USER_MESSAGE_GROUPS_STATE_KEY: (
            {"mode": "replace", "groups": normalized} if replace else normalized
        )
    }


def build_structured_user_message_groups_reset_update() -> dict[str, dict[str, Any]]:
    return {STRUCTURED_USER_MESSAGE_GROUPS_STATE_KEY: {"mode": "reset", "groups": []}}


def merge_structured_user_group_replay_markers(left: Any, right: Any) -> dict[str, dict[str, Any]]:
    current = {str(key): dict(value) for key, value in dict(left or {}).items()}
    if not right:
        return current
    if isinstance(right, Mapping) and str(right.get("mode") or "") == "reset":
        return {}
    updates = dict(right or {})
    for raw_key, raw_value in updates.items():
        key = str(raw_key).strip()
        if not key or not isinstance(raw_value, Mapping):
            raise ValueError("structured user group replay marker 必须是对象")
        boundary_id = str(raw_value.get("boundary_id") or "").strip()
        group_id = str(raw_value.get("group_id") or "").strip()
        status = str(raw_value.get("status") or "pending").strip()
        if not boundary_id or not group_id or status not in {"pending", "consumed"}:
            raise ValueError("structured user group replay marker 字段无效")
        current[key] = {
            "boundary_id": boundary_id,
            "group_id": group_id,
            "status": status,
        }
    return current


def build_structured_user_group_replay_marker_update(
    *,
    boundary_id: str,
    group_ids: list[str],
    consumed: bool = False,
) -> dict[str, dict[str, dict[str, str]]]:
    status = "consumed" if consumed else "pending"
    markers = {
        f"{boundary_id}:{group_id}": {
            "boundary_id": boundary_id,
            "group_id": group_id,
            "status": status,
        }
        for group_id in group_ids
    }
    return {STRUCTURED_USER_GROUP_REPLAY_MARKERS_STATE_KEY: markers}


class KeydexAgentState(TypedDict, total=False):
    messages: Annotated[list[AnyMessage], add_messages]
    structured_user_message_groups: Annotated[
        list[dict[str, Any]],
        merge_structured_user_message_groups,
    ]
    structured_user_group_replay_markers: Annotated[
        dict[str, dict[str, Any]],
        merge_structured_user_group_replay_markers,
    ]
    pending_tool_call_preset: dict[str, Any] | None
    context_compression_diagnostics: dict[str, Any] | None
    pending_skill_activations: Annotated[
        list[dict[str, Any]],
        merge_pending_skill_activations,
    ]
