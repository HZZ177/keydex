from __future__ import annotations

import json
from typing import Any

from backend.app.agent.tool_results.budgets import ToolResultPolicy, utf8_bytes
from backend.app.agent.tool_results.continuations import issue_search_cursor
from backend.app.agent.tool_results.models import ToolResultProjection
from backend.app.agent.tool_results.projectors import projection_from_display_payload


def read_file_projector(
    result: Any,
    *,
    tool_name: str,
    policy: ToolResultPolicy,
    context: Any,
) -> ToolResultProjection:
    if not isinstance(result, dict):
        return projection_from_display_payload(
            result,
            original_result=result,
            tool_name=tool_name,
            policy=policy,
        )
    display = {key: value for key, value in result.items() if key != "content"}
    source_paginated = bool(display.get("truncated"))
    projection = projection_from_display_payload(
        display,
        original_result=result,
        tool_name=tool_name,
        policy=policy,
        truncated=source_paginated,
        continuation=_read_continuation(display),
        reason_code="requested_window" if source_paginated else None,
    )
    if (
        utf8_bytes(projection.model_content) <= policy.budget_bytes
        and "results" not in projection.display_payload
    ):
        if "result_preview" not in projection.display_payload:
            return projection

    numbered = str(display.get("numbered_content") or "")
    lines = numbered.splitlines(keepends=True)
    low, high = 0, len(lines)
    best: ToolResultProjection | None = None
    start_line = int(display.get("start_line") or 1)
    while low <= high:
        count = (low + high) // 2
        candidate = {
            **display,
            "numbered_content": "".join(lines[:count]),
            "returned_lines": count,
            "truncated": count < len(lines) or bool(display.get("truncated")),
            "next_start_line": start_line + count,
        }
        if not candidate["truncated"]:
            candidate["next_start_line"] = None
        projected = projection_from_display_payload(
            candidate,
            original_result=result,
            tool_name=tool_name,
            policy=policy,
            truncated=bool(candidate["truncated"]),
            continuation=_read_continuation(candidate),
            reason_code="model_byte_budget" if count < len(lines) else None,
        )
        if (
            utf8_bytes(projected.model_content) <= policy.budget_bytes
            and "result_preview" not in projected.display_payload
        ):
            best = projected
            low = count + 1
        else:
            high = count - 1
    return best or projection


def list_dir_projector(
    result: Any,
    *,
    tool_name: str,
    policy: ToolResultPolicy,
    context: Any,
) -> ToolResultProjection:
    del context
    if not isinstance(result, dict):
        return projection_from_display_payload(
            result,
            original_result=result,
            tool_name=tool_name,
            policy=policy,
        )
    projection = projection_from_display_payload(
        result,
        original_result=result,
        tool_name=tool_name,
        policy=policy,
        truncated=bool(result.get("truncated")),
        continuation=_list_continuation(result),
    )
    if "result_preview" not in projection.display_payload:
        return projection
    tree_lines = str(result.get("tree") or "").splitlines()
    offset = int(result.get("offset") or 0)
    low, high = 0, max(0, len(tree_lines) - 1)
    best: ToolResultProjection | None = None
    while low <= high:
        count = (low + high) // 2
        kept = tree_lines[: count + 1]
        returned = max(0, len(kept) - 1)
        candidate = {
            **result,
            "tree": "\n".join(kept),
            "returned_entries": returned,
            "truncated": True,
            "next_offset": offset + returned if returned else None,
            "truncation_reason": "model_byte_budget",
        }
        projected = projection_from_display_payload(
            candidate,
            original_result=result,
            tool_name=tool_name,
            policy=policy,
            truncated=True,
            continuation=_list_continuation(candidate),
            reason_code="model_byte_budget",
        )
        if "result_preview" not in projected.display_payload:
            best = projected
            low = count + 1
        else:
            high = count - 1
    return best or projection


def search_text_projector(
    result: Any,
    *,
    tool_name: str,
    policy: ToolResultPolicy,
    context: Any,
) -> ToolResultProjection:
    return _search_projector(
        result,
        kind="search_text",
        tool_name=tool_name,
        policy=policy,
        context=context,
    )


def grep_files_projector(
    result: Any,
    *,
    tool_name: str,
    policy: ToolResultPolicy,
    context: Any,
) -> ToolResultProjection:
    return _search_projector(
        result,
        kind="grep_files",
        tool_name=tool_name,
        policy=policy,
        context=context,
    )


def search_files_projector(
    result: Any,
    *,
    tool_name: str,
    policy: ToolResultPolicy,
    context: Any,
) -> ToolResultProjection:
    return _search_projector(
        result,
        kind="search_files",
        tool_name=tool_name,
        policy=policy,
        context=context,
    )


def command_result_projector(
    result: Any,
    *,
    tool_name: str,
    policy: ToolResultPolicy,
    context: Any,
) -> ToolResultProjection:
    del context
    if not isinstance(result, dict):
        return projection_from_display_payload(
            result,
            original_result=result,
            tool_name=tool_name,
            policy=policy,
        )
    excluded = {
        "command",
        "shell_path",
        "output_path",
        "stdout",
        "stderr",
        "stdout_tail",
        "stderr_tail",
        "combined_tail",
    }
    display = {key: value for key, value in result.items() if key not in excluded}
    combined = str(result.get("combined_tail") or "")
    if not combined:
        sections = []
        if stdout := str(result.get("stdout") or result.get("stdout_tail") or ""):
            sections.append(f"[stdout]\n{stdout}")
        if stderr := str(result.get("stderr") or result.get("stderr_tail") or ""):
            sections.append(f"[stderr]\n{stderr}")
        combined = "\n".join(sections)
    display["combined_output"] = combined
    command_id = str(result.get("command_id") or "").strip()
    display["output_ref"] = (
        f"command_log:{command_id}"
        if result.get("output_path") and command_id
        else None
    )
    projection = projection_from_display_payload(
        display,
        original_result=result,
        tool_name=tool_name,
        policy=policy,
        truncated=bool(result.get("output_truncated")),
    )
    if "result_preview" not in projection.display_payload:
        return projection
    encoded = combined.encode("utf-8")
    low, high = 0, min(len(encoded), policy.budget_bytes)
    best: ToolResultProjection | None = None
    while low <= high:
        keep = (low + high) // 2
        candidate = {
            **display,
            "combined_output": _head_tail_bytes(combined, keep),
            "output_truncated": True,
        }
        projected = projection_from_display_payload(
            candidate,
            original_result=result,
            tool_name=tool_name,
            policy=policy,
            truncated=True,
            reason_code="model_byte_budget",
        )
        if "result_preview" not in projected.display_payload:
            best = projected
            low = keep + 1
        else:
            high = keep - 1
    return best or projection


def mutation_result_projector(
    result: Any,
    *,
    tool_name: str,
    policy: ToolResultPolicy,
    context: Any,
) -> ToolResultProjection:
    del context
    if not isinstance(result, dict):
        return projection_from_display_payload(
            result,
            original_result=result,
            tool_name=tool_name,
            policy=policy,
        )
    raw_files = result.get("files") or result.get("changes") or []
    files = [item for item in raw_files if isinstance(item, dict)]
    summary_keys = {
        "path",
        "old_path",
        "new_path",
        "created",
        "changed",
        "deleted",
        "moved",
        "match_count",
        "size",
        "status",
    }
    base = {key: value for key, value in result.items() if key in summary_keys}
    for diff_limit in (8192, 4096, 2048, 512, 0):
        compact_files = [_compact_file_change(item, diff_limit) for item in files]
        display = {
            **base,
            "files": compact_files,
            "changed_files": len(compact_files),
            "diff_truncated": any(item.get("diff_truncated") for item in compact_files),
        }
        projection = projection_from_display_payload(
            display,
            original_result=result,
            tool_name=tool_name,
            policy=policy,
            truncated=bool(display["diff_truncated"]),
            reason_code="diff_budget" if display["diff_truncated"] else None,
        )
        if "result_preview" not in projection.display_payload:
            return projection
    return projection_from_display_payload(
        {
            **base,
            "files": [
                {"path": str(item.get("path") or ""), "operation": item.get("operation")}
                for item in files
            ],
            "changed_files": len(files),
            "diff_truncated": True,
        },
        original_result=result,
        tool_name=tool_name,
        policy=policy,
        truncated=True,
        reason_code="diff_budget",
    )


def mcp_result_projector(
    result: Any,
    *,
    tool_name: str,
    policy: ToolResultPolicy,
    context: Any,
) -> ToolResultProjection:
    del context
    if not isinstance(result, dict):
        return projection_from_display_payload(
            result,
            original_result=result,
            tool_name=tool_name,
            policy=policy,
        )
    metadata = result.get("metadata") if isinstance(result.get("metadata"), dict) else {}
    complete = not bool(metadata.get("result_truncated"))
    display = {
        "call_id": result.get("call_id"),
        "status": result.get("status"),
        "content": result.get("content") or [],
        "structured_content": result.get("structured_content"),
        "is_error": bool(result.get("is_error")),
        "metadata": metadata,
        "artifact_complete": complete,
    }
    projection = projection_from_display_payload(
        display,
        original_result=result,
        tool_name=tool_name,
        policy=policy,
        truncated=not complete,
        reason_code="mcp_upstream_result_truncated" if not complete else None,
        artifact_complete=complete,
    )
    if "result_preview" not in projection.display_payload:
        return projection
    content_json = json.dumps(display["content"], ensure_ascii=False, default=str)
    structured_json = json.dumps(
        display["structured_content"],
        ensure_ascii=False,
        default=str,
    )
    for preview_limit in (12_000, 6_000, 2_000, 512, 0):
        compact = {
            "call_id": display["call_id"],
            "status": display["status"],
            "is_error": display["is_error"],
            "artifact_complete": complete,
            "content_preview": _head_tail_bytes(content_json, preview_limit),
            "structured_content_preview": _head_tail_bytes(structured_json, preview_limit),
            "metadata": metadata,
        }
        candidate = projection_from_display_payload(
            compact,
            original_result=result,
            tool_name=tool_name,
            policy=policy,
            truncated=True,
            reason_code=(
                "mcp_upstream_result_truncated" if not complete else "model_byte_budget"
            ),
            artifact_complete=complete,
        )
        if "result_preview" not in candidate.display_payload:
            return candidate
    return projection


def web_result_projector(
    result: Any,
    *,
    tool_name: str,
    policy: ToolResultPolicy,
    context: Any,
) -> ToolResultProjection:
    del context
    if not isinstance(result, dict):
        return projection_from_display_payload(
            result,
            original_result=result,
            tool_name=tool_name,
            policy=policy,
        )
    display = dict(result)
    if tool_name == "web_search":
        display["sources"] = [
            _compact_web_source(item)
            for item in result.get("sources", [])
            if isinstance(item, dict)
        ]
    else:
        display["items"] = [
            _compact_web_fetch_item(item)
            for item in result.get("items", [])
            if isinstance(item, dict)
        ]
    projection_truncated = _web_result_truncated(display)
    artifact_complete = _web_artifact_complete(result)
    return projection_from_display_payload(
        display,
        original_result=result,
        tool_name=tool_name,
        policy=policy,
        truncated=projection_truncated,
        reason_code=(
            "web_upstream_result_truncated"
            if not artifact_complete
            else "web_content_summary"
            if projection_truncated
            else None
        ),
        artifact_complete=artifact_complete,
    )


def subagent_result_projector(
    result: Any,
    *,
    tool_name: str,
    policy: ToolResultPolicy,
    context: Any,
) -> ToolResultProjection:
    del context
    source_truncated = bool(
        isinstance(result, dict) and result.get("report_truncated")
    )
    return projection_from_display_payload(
        result,
        original_result=result,
        tool_name=tool_name,
        policy=policy,
        truncated=source_truncated,
        reason_code="subagent_report_incomplete" if source_truncated else None,
        artifact_complete=not source_truncated,
    )


def _compact_web_source(value: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "source_id",
        "url",
        "domain",
        "title",
        "favicon",
        "published_at",
        "truncated",
    )
    source = {key: value[key] for key in keys if key in value}
    snippet = str(value.get("snippet") or "")
    if snippet:
        source["snippet"] = _utf8_prefix(snippet, 2000)
    return source


def _compact_web_fetch_item(value: dict[str, Any]) -> dict[str, Any]:
    compact = {
        key: value[key]
        for key in ("requested_url", "status", "error_code", "error_message")
        if key in value
    }
    source_value = value.get("source") if isinstance(value.get("source"), dict) else None
    if source_value is not None:
        compact["source"] = _compact_web_source(source_value)
    content = str(value.get("content") or "")
    if content:
        compact["content"] = _utf8_prefix(content, 2000)
        if len(content.encode("utf-8")) > 2000:
            compact["content_truncated_for_model"] = True
    return compact


def _web_result_truncated(value: dict[str, Any]) -> bool:
    if bool(value.get("truncated")):
        return True
    metadata = value.get("metadata") if isinstance(value.get("metadata"), dict) else {}
    if metadata.get("sources_truncated"):
        return True
    for item in value.get("items", []) if isinstance(value.get("items"), list) else []:
        if not isinstance(item, dict):
            continue
        if item.get("content_truncated_for_model"):
            return True
        source = item.get("source") if isinstance(item.get("source"), dict) else {}
        if source.get("truncated"):
            return True
    return False


def _web_artifact_complete(value: dict[str, Any]) -> bool:
    if bool(value.get("truncated")):
        return False
    metadata = value.get("metadata") if isinstance(value.get("metadata"), dict) else {}
    if metadata.get("sources_truncated"):
        return False
    for source in value.get("sources", []) if isinstance(value.get("sources"), list) else []:
        if isinstance(source, dict) and source.get("truncated"):
            return False
    for item in value.get("items", []) if isinstance(value.get("items"), list) else []:
        if not isinstance(item, dict):
            continue
        source = item.get("source") if isinstance(item.get("source"), dict) else {}
        if source.get("truncated"):
            return False
    return True


def _compact_file_change(item: dict[str, Any], diff_limit: int) -> dict[str, Any]:
    keys = (
        "path",
        "old_path",
        "new_path",
        "operation",
        "change_type",
        "added_lines",
        "deleted_lines",
        "completed",
        "created",
        "removed_bytes",
    )
    compact = {key: item[key] for key in keys if key in item}
    diff = str(item.get("diff") or "")
    diff_bytes = len(diff.encode("utf-8"))
    compact["full_diff_bytes"] = diff_bytes
    compact["diff_truncated"] = diff_bytes > diff_limit
    if diff_limit > 0 and diff:
        compact["diff"] = _head_tail_bytes(diff, diff_limit)
    return compact


def _search_projector(
    result: Any,
    *,
    kind: str,
    tool_name: str,
    policy: ToolResultPolicy,
    context: Any,
) -> ToolResultProjection:
    if not isinstance(result, dict) or not isinstance(result.get("results"), list):
        return projection_from_display_payload(
            result,
            original_result=result,
            tool_name=tool_name,
            policy=policy,
        )
    original_items = sorted(
        [item for item in result["results"] if isinstance(item, dict)],
        key=lambda item: (
            str(item.get("path") or "").lower(),
            int(item.get("line") or item.get("first_line") or 0),
        ),
    )
    args = dict(getattr(context, "metadata", {}).get("tool_args") or {})
    cursor_info = getattr(context, "metadata", {}).get("search_continuation")
    base_offset = int(getattr(cursor_info, "offset", 0) or 0)
    logical_query_id = getattr(cursor_info, "logical_query_id", None)
    page_index = int(getattr(cursor_info, "page_index", 0) or 0) + 1
    source_truncated = bool(result.get("truncated"))

    for snippet_bytes in (600, 240, 80, 0):
        compacted = [_compact_search_item(item, kind, snippet_bytes) for item in original_items]
        content_compacted = _search_content_compacted(
            original_items,
            compacted,
            kind=kind,
        )
        reason_code = _search_projection_reason(
            source_truncated=source_truncated,
            content_compacted=content_compacted,
        )
        candidate = _search_display(
            result,
            compacted,
            total=len(original_items),
            source_truncated=source_truncated,
        )
        projected = projection_from_display_payload(
            candidate,
            original_result=result,
            tool_name=tool_name,
            policy=policy,
            truncated=source_truncated or content_compacted,
            reason_code=reason_code,
        )
        if "result_preview" not in projected.display_payload:
            if source_truncated:
                next_cursor = issue_search_cursor(
                    tool_name=tool_name,
                    args=args,
                    offset=base_offset + len(compacted),
                    logical_query_id=logical_query_id,
                    page_index=page_index,
                )
                candidate["next_cursor"] = next_cursor
                projected = projection_from_display_payload(
                    candidate,
                    original_result=result,
                    tool_name=tool_name,
                    policy=policy,
                    truncated=True,
                    continuation={"kind": "next_cursor", "value": next_cursor},
                    reason_code=reason_code,
                )
            if "result_preview" not in projected.display_payload:
                return projected

    identity_items = [_compact_search_item(item, kind, 0) for item in original_items]
    low, high = 0, len(identity_items)
    best: ToolResultProjection | None = None
    while low <= high:
        count = (low + high) // 2
        next_cursor = issue_search_cursor(
            tool_name=tool_name,
            args=args,
            offset=base_offset + count,
            logical_query_id=logical_query_id,
            page_index=page_index,
        )
        candidate = _search_display(
            result,
            identity_items[:count],
            total=len(identity_items),
            source_truncated=True,
        )
        candidate["next_cursor"] = next_cursor
        projected = projection_from_display_payload(
            candidate,
            original_result=result,
            tool_name=tool_name,
            policy=policy,
            truncated=True,
            continuation={"kind": "next_cursor", "value": next_cursor},
            reason_code="model_byte_budget",
        )
        if "result_preview" not in projected.display_payload:
            best = projected
            low = count + 1
        else:
            high = count - 1
    return best or projection_from_display_payload(
        {
            "ok": False,
            "error": {
                "code": "search_projection_failed",
                "message": "搜索结果身份超过模型预算，请收窄 path/include。",
            },
        },
        original_result=result,
        tool_name=tool_name,
        policy=policy,
        truncated=True,
        reason_code="search_projection_failed",
    )


def _compact_search_item(item: dict[str, Any], kind: str, snippet_bytes: int) -> dict[str, Any]:
    if kind == "search_text":
        compact = {"path": str(item.get("path") or ""), "line": int(item.get("line") or 0)}
    elif kind == "grep_files":
        compact = {
            "path": str(item.get("path") or ""),
            "matches": int(item.get("matches") or 0),
            "first_line": int(item.get("first_line") or 0),
        }
    else:
        compact = {key: item[key] for key in ("path", "type", "size") if key in item}
    snippet = str(item.get("snippet") or "")
    if snippet_bytes > 0 and snippet:
        compact["snippet"] = _utf8_prefix(snippet, snippet_bytes)
    return compact


def _search_content_compacted(
    original_items: list[dict[str, Any]],
    compacted_items: list[dict[str, Any]],
    *,
    kind: str,
) -> bool:
    for original, compacted in zip(original_items, compacted_items, strict=True):
        if str(original.get("snippet") or "") != str(compacted.get("snippet") or ""):
            return True
        if kind == "search_text" and any(
            original.get(key) not in (None, [], "")
            for key in ("before_context", "after_context", "context_before", "context_after")
        ):
            return True
    return False


def _search_projection_reason(
    *,
    source_truncated: bool,
    content_compacted: bool,
) -> str | None:
    if source_truncated and content_compacted:
        return "search_source_and_result_compacted"
    if source_truncated:
        return "search_source_truncated"
    if content_compacted:
        return "search_result_compacted"
    return None


def _search_display(
    source: dict[str, Any],
    items: list[dict[str, Any]],
    *,
    total: int,
    source_truncated: bool,
) -> dict[str, Any]:
    excluded = {"results", "paths", "modified_time", "next_cursor"}
    base = {key: value for key, value in source.items() if key not in excluded}
    return {
        **base,
        "results": items,
        "total_results": total,
        "returned_results": len(items),
        "omitted_results": max(0, total - len(items)),
        "truncated": source_truncated or len(items) < total,
        "next_cursor": None,
    }


def _read_continuation(payload: dict[str, Any]) -> dict[str, Any] | None:
    value = payload.get("next_start_line")
    return {"kind": "next_start_line", "value": value} if value is not None else None


def _list_continuation(payload: dict[str, Any]) -> dict[str, Any] | None:
    value = payload.get("next_offset")
    return {"kind": "next_offset", "value": value} if value is not None else None


def _utf8_prefix(value: str, max_bytes: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    marker = "…"
    budget = max(0, max_bytes - len(marker.encode("utf-8")))
    return encoded[:budget].decode("utf-8", errors="ignore") + marker


def _head_tail_bytes(value: str, max_bytes: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    marker = b"\n... [command output omitted] ...\n"
    if max_bytes <= len(marker):
        return marker[:max_bytes].decode("utf-8", errors="ignore")
    remaining = max_bytes - len(marker)
    head_size = remaining // 3
    tail_size = remaining - head_size
    return (
        encoded[:head_size].decode("utf-8", errors="ignore")
        + marker.decode("ascii")
        + encoded[-tail_size:].decode("utf-8", errors="ignore")
    )
