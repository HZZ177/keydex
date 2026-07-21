from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

from backend.app.agent.tool_results.budgets import (
    GLOBAL_TOOL_RESULT_BUDGET_BYTES,
    ToolResultPolicy,
    approximate_tokens,
    utf8_bytes,
)
from backend.app.agent.tool_results.models import (
    ToolResultProjection,
    ToolResultProjectionMeta,
    ToolResultProjector,
)

PROJECTION_FIELD = "_keydex_projection"


def project_tool_result(
    result: Any,
    *,
    tool_name: str,
    policy: ToolResultPolicy,
    context: Any,
    projector: ToolResultProjector | None = None,
) -> ToolResultProjection:
    try:
        projection = (
            projector(
                result,
                tool_name=tool_name,
                policy=policy,
                context=context,
            )
            if projector is not None
            else generic_projector(
                result,
                tool_name=tool_name,
                policy=policy,
                context=context,
            )
        )
    except Exception:
        projection = _projection_failure(
            tool_name=tool_name,
            policy=policy,
            reason_code="tool_result_projection_failed",
            message="工具结果无法安全投影，原始内容未发送给模型。",
        )
    return enforce_global_guard(projection, tool_name=tool_name, policy=policy)


def generic_projector(
    result: Any,
    *,
    tool_name: str,
    policy: ToolResultPolicy,
    context: Any,
) -> ToolResultProjection:
    del context
    safe_result = make_json_serializable(result)
    full_content = _json_dumps(safe_result)
    full_bytes = utf8_bytes(full_content)
    continuation = _continuation_from_payload(safe_result)

    display_payload = _display_with_meta(
        safe_result,
        _meta(
            tool_name=tool_name,
            full_bytes=full_bytes,
            budget_bytes=policy.budget_bytes,
            truncated=False,
            continuation=continuation,
        ),
    )
    projection = _finalize_projection(display_payload)
    if utf8_bytes(projection.model_content) <= policy.budget_bytes:
        return projection

    if policy.must_be_complete:
        return _projection_failure(
            tool_name=tool_name,
            policy=policy,
            reason_code="tool_result_too_large_for_model",
            message=(
                "该工具结果要求完整交付，但超过 32KB 模型上下文上限；"
                "请将内容拆分为更小的资源后重试。"
            ),
            full_bytes=full_bytes,
        )

    return _truncated_projection(
        full_content,
        tool_name=tool_name,
        policy=policy,
        continuation=continuation,
    )


def projection_from_display_payload(
    display_payload: Any,
    *,
    original_result: Any,
    tool_name: str,
    policy: ToolResultPolicy,
    continuation: dict[str, Any] | None = None,
    truncated: bool = False,
    reason_code: str | None = None,
    artifact_complete: bool = True,
) -> ToolResultProjection:
    """Finalize a specialized display payload while accounting for the full raw result."""

    safe_original = make_json_serializable(original_result)
    full_bytes = utf8_bytes(_json_dumps(safe_original))
    safe_display = make_json_serializable(display_payload)
    meta = _meta(
        tool_name=tool_name,
        full_bytes=full_bytes,
        budget_bytes=policy.budget_bytes,
        truncated=truncated,
        continuation=continuation,
        artifact_complete=artifact_complete,
        reason_code=reason_code,
    )
    payload = _display_with_meta(safe_display, meta)
    projection = _finalize_projection(payload)
    return enforce_global_guard(projection, tool_name=tool_name, policy=policy)


def enforce_global_guard(
    projection: ToolResultProjection,
    *,
    tool_name: str,
    policy: ToolResultPolicy,
) -> ToolResultProjection:
    hard_budget = min(policy.budget_bytes, GLOBAL_TOOL_RESULT_BUDGET_BYTES)
    if utf8_bytes(projection.model_content) <= hard_budget:
        return projection
    if policy.must_be_complete:
        return _projection_failure(
            tool_name=tool_name,
            policy=policy,
            reason_code="tool_result_too_large_for_model",
            message=(
                "该工具结果要求完整交付，但超过 32KB 模型上下文上限；"
                "请将内容拆分为更小的资源后重试。"
            ),
            full_bytes=projection.meta.full_bytes,
        )
    return _truncated_projection(
        projection.model_content,
        tool_name=tool_name,
        policy=replace(policy, budget_bytes=hard_budget),
        continuation=projection.meta.continuation,
        artifact_id=projection.meta.artifact_id,
        artifact_complete=projection.meta.artifact_complete,
        persisted_ref=projection.persisted_ref,
    )


def attach_persisted_ref(
    projection: ToolResultProjection,
    *,
    persisted_ref: dict[str, Any],
    tool_name: str,
    policy: ToolResultPolicy,
) -> ToolResultProjection:
    artifact_id = str(persisted_ref.get("artifact_id") or "").strip()
    if not artifact_id:
        return projection
    complete = bool(persisted_ref.get("is_complete", projection.meta.artifact_complete))
    meta = projection.meta.model_copy(
        update={"artifact_id": artifact_id, "artifact_complete": complete}
    )
    display = make_json_serializable(projection.display_payload)
    if isinstance(display, dict):
        display[PROJECTION_FIELD] = meta.model_dump(mode="json")
        if "artifact_complete" in display:
            display["artifact_complete"] = complete
        if meta.truncated:
            display["artifact_id"] = artifact_id
    attached = _finalize_projection(display, persisted_ref=persisted_ref)
    return enforce_global_guard(attached, tool_name=tool_name, policy=policy)


def make_json_serializable(value: Any) -> Any:
    return _make_json_serializable(value, seen=set(), depth=0)


def _make_json_serializable(value: Any, *, seen: set[int], depth: int) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if depth >= 30:
        return "<maximum serialization depth reached>"
    object_id = id(value)
    if isinstance(value, (dict, list, tuple, set)):
        if object_id in seen:
            return "<circular reference>"
        seen.add(object_id)
        try:
            if isinstance(value, dict):
                return {
                    str(key): _make_json_serializable(item, seen=seen, depth=depth + 1)
                    for key, item in value.items()
                }
            return [
                _make_json_serializable(item, seen=seen, depth=depth + 1)
                for item in value
            ]
        finally:
            seen.remove(object_id)
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            return _make_json_serializable(model_dump(mode="json"), seen=seen, depth=depth + 1)
        except Exception:
            return f"<{type(value).__name__}>"
    try:
        return str(value)
    except Exception:
        return f"<{type(value).__name__}>"


def _truncated_projection(
    full_content: str,
    *,
    tool_name: str,
    policy: ToolResultPolicy,
    continuation: dict[str, Any] | None,
    artifact_id: str | None = None,
    artifact_complete: bool = True,
    persisted_ref: dict[str, Any] | None = None,
) -> ToolResultProjection:
    full_bytes = utf8_bytes(full_content)
    low = 0
    high = min(full_bytes, policy.budget_bytes)
    best: ToolResultProjection | None = None
    while low <= high:
        preview_bytes = (low + high) // 2
        preview = _head_tail_utf8(full_content, preview_bytes)
        meta = _meta(
            tool_name=tool_name,
            full_bytes=full_bytes,
            budget_bytes=policy.budget_bytes,
            truncated=True,
            continuation=continuation,
            artifact_id=artifact_id,
            artifact_complete=artifact_complete,
            reason_code="budget_exceeded",
        )
        display_payload = {
            "ok": True,
            "status": "truncated",
            "truncated": True,
            "result_preview": preview,
            PROJECTION_FIELD: meta.model_dump(mode="json"),
        }
        candidate = _finalize_projection(display_payload, persisted_ref=persisted_ref)
        if utf8_bytes(candidate.model_content) <= policy.budget_bytes:
            best = candidate
            low = preview_bytes + 1
        else:
            high = preview_bytes - 1
    if best is not None:
        return best
    return _projection_failure(
        tool_name=tool_name,
        policy=policy,
        reason_code="tool_result_budget_too_small",
        message="工具结果预算不足，无法生成安全投影。",
        full_bytes=full_bytes,
    )


def _projection_failure(
    *,
    tool_name: str,
    policy: ToolResultPolicy,
    reason_code: str,
    message: str,
    full_bytes: int = 0,
) -> ToolResultProjection:
    meta = _meta(
        tool_name=tool_name,
        full_bytes=full_bytes,
        budget_bytes=min(policy.budget_bytes, GLOBAL_TOOL_RESULT_BUDGET_BYTES),
        truncated=full_bytes > 0,
        continuation=None,
        artifact_complete=False,
        reason_code=reason_code,
    )
    display_payload = {
        "tool": tool_name,
        "ok": False,
        "status": "failed",
        "error": {"code": reason_code, "message": message, "retryable": False},
        PROJECTION_FIELD: meta.model_dump(mode="json"),
    }
    return _finalize_projection(display_payload)


def _display_with_meta(result: Any, meta: ToolResultProjectionMeta) -> Any:
    if isinstance(result, dict):
        return {**result, PROJECTION_FIELD: meta.model_dump(mode="json")}
    return {"result": result, PROJECTION_FIELD: meta.model_dump(mode="json")}


def _finalize_projection(
    display_payload: Any,
    *,
    persisted_ref: dict[str, Any] | None = None,
) -> ToolResultProjection:
    payload = make_json_serializable(display_payload)
    for _ in range(3):
        content = _json_dumps(payload)
        model_bytes = utf8_bytes(content)
        if isinstance(payload, dict) and isinstance(payload.get(PROJECTION_FIELD), dict):
            projection_meta = payload[PROJECTION_FIELD]
            projection_meta["model_bytes"] = model_bytes
            projection_meta["approximate_model_tokens"] = approximate_tokens(model_bytes)
    content = _json_dumps(payload)
    meta = ToolResultProjectionMeta.model_validate(payload[PROJECTION_FIELD])
    return ToolResultProjection(
        model_content=content,
        display_payload=payload,
        meta=meta,
        persisted_ref=persisted_ref,
    )


def _meta(
    *,
    tool_name: str,
    full_bytes: int,
    budget_bytes: int,
    truncated: bool,
    continuation: dict[str, Any] | None,
    artifact_id: str | None = None,
    artifact_complete: bool = True,
    reason_code: str | None = None,
) -> ToolResultProjectionMeta:
    return ToolResultProjectionMeta(
        tool_name=tool_name,
        full_bytes=full_bytes,
        model_bytes=0,
        approximate_full_tokens=approximate_tokens(full_bytes),
        approximate_model_tokens=0,
        budget_bytes=budget_bytes,
        truncated=truncated,
        continuation=continuation,
        artifact_id=artifact_id,
        artifact_complete=artifact_complete,
        reason_code=reason_code,
    )


def _continuation_from_payload(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    for key in ("next_cursor", "next_offset", "next_start_line"):
        value = payload.get(key)
        if value is not None:
            return {"kind": key, "value": value}
    return None


def _head_tail_utf8(value: str, max_bytes: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    marker = b"\n... [tool result omitted] ...\n"
    if max_bytes <= len(marker):
        return _decode_prefix(marker, max_bytes)
    remaining = max_bytes - len(marker)
    head_size = remaining * 2 // 3
    tail_size = remaining - head_size
    head = encoded[:head_size].decode("utf-8", errors="ignore")
    tail = encoded[-tail_size:].decode("utf-8", errors="ignore") if tail_size else ""
    return head + marker.decode("ascii") + tail


def _decode_prefix(value: bytes, max_bytes: int) -> str:
    return value[:max_bytes].decode("utf-8", errors="ignore")


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
