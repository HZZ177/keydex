from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage

from backend.app.agent.context_compression_segments import (
    TRUNCATED_TOOL_RESULT_METADATA_KEY,
    approximate_message_tokens,
)
from backend.app.command_approval import load_command_settings
from backend.app.storage import SessionRecord, StorageRepositories
from backend.app.tools.base import ToolExecutionContext
from backend.app.tools.file_access import resolve_file_access_path
from backend.app.tools.filesystem import DEFAULT_MAX_LINES, MAX_MAX_LINES

COMPACT_RUNTIME_ATTACHMENT_METADATA_KEY = "keydex_compact_runtime_attachment"
RECENT_READ_MANIFEST_MAX_ENTRIES = 5
RECENT_READ_SNIPPET_MAX_TOKENS_PER_RANGE = 2_000
RECENT_READ_SNIPPET_MAX_TOKENS_TOTAL = 4_000
RECENT_READ_CURRENT_FILE_MAX_BYTES = 512 * 1024


@dataclass(frozen=True, slots=True)
class CompactRuntimeAttachment:
    kind: str
    message: HumanMessage
    approximate_tokens: int
    source_tool_call_ids: tuple[str, ...]
    optional: bool


@dataclass(frozen=True, slots=True)
class CompactRuntimeAttachmentSelection:
    attachments: tuple[CompactRuntimeAttachment, ...]
    dropped: tuple[dict[str, str], ...]


def build_current_text_reader(
    repositories: StorageRepositories,
    *,
    session: SessionRecord,
    user_id: str,
    turn_index: int = 0,
) -> Callable[[str], str] | None:
    if session.session_type != "workspace" or not session.workspace_id:
        return None
    workspace = repositories.workspaces.get(session.workspace_id)
    if workspace is None:
        return None
    context = ToolExecutionContext(
        session_id=session.id,
        active_session_id=session.active_session_id or session.id,
        user_id=user_id,
        workspace_root=Path(workspace.root_path),
        turn_index=max(int(turn_index), 0),
        metadata={
            "repositories": repositories,
            "file_access_mode": load_command_settings(repositories).file_access_mode,
        },
    )

    def read_current(raw_path: str) -> str:
        path = resolve_file_access_path(raw_path, context, operation="read")
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(raw_path)
        if path.stat().st_size > RECENT_READ_CURRENT_FILE_MAX_BYTES:
            raise ValueError("recent-read current file exceeds safe read limit")
        return path.read_text(encoding="utf-8")

    return read_current


def build_latest_plan_attachment(
    messages: list[BaseMessage],
    *,
    tail_tool_call_ids: set[str] | None = None,
) -> CompactRuntimeAttachment | None:
    latest: tuple[str, dict[str, Any]] | None = None
    for message in messages:
        if not isinstance(message, AIMessage):
            continue
        for call in message.tool_calls:
            if call.get("name") != "update_plan" or not isinstance(call.get("args"), dict):
                continue
            plan = call["args"].get("plan")
            if not isinstance(plan, list):
                continue
            latest = (str(call.get("id") or ""), dict(call["args"]))
    if latest is None or latest[0] in (tail_tool_call_ids or set()):
        return None
    tool_call_id, payload = latest
    content = (
        "当前计划完整快照（压缩恢复附件，不是新的用户请求）：\n\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}"
    )
    message = _runtime_attachment_message(
        kind="plan_snapshot",
        content=content,
        source_tool_call_ids=[tool_call_id],
    )
    return CompactRuntimeAttachment(
        kind="plan_snapshot",
        message=message,
        approximate_tokens=approximate_message_tokens(message),
        source_tool_call_ids=(tool_call_id,),
        optional=False,
    )


def build_recent_read_attachments(
    messages: list[BaseMessage],
    *,
    available_tokens: int,
    read_current: Callable[[str], str] | None = None,
    tail_tool_call_ids: set[str] | None = None,
) -> CompactRuntimeAttachmentSelection:
    reads = _collect_recent_reads(messages)
    reads = [
        item
        for item in reversed(reads)
        if not set(item.get("tool_call_ids") or [item["tool_call_id"]]).intersection(
            tail_tool_call_ids or set()
        )
        and not _is_instruction_path(item["path"])
    ]
    unique: list[dict[str, Any]] = []
    for item in reads:
        _append_or_merge_read_window(unique, item)
        if len(unique) >= RECENT_READ_MANIFEST_MAX_ENTRIES:
            break

    dropped: list[dict[str, str]] = []
    if not unique:
        return CompactRuntimeAttachmentSelection((), ())
    manifest_payload = [
        {
            "path": item["path"],
            "purpose_or_range": _read_range_label(item),
            "last_read_time": item["time"],
            "current_change_state": "unknown_until_verified",
        }
        for item in unique
    ]
    manifest_message = _runtime_attachment_message(
        kind="recent_read_manifest",
        content=(
            "最近读取文件清单（压缩恢复附件，不要求自动重读全部文件）：\n\n"
            f"{json.dumps(manifest_payload, ensure_ascii=False, indent=2)}"
        ),
        source_tool_call_ids=_read_tool_call_ids(unique),
        metadata_payload={"recent_reads": [dict(item) for item in unique]},
    )
    manifest_tokens = approximate_message_tokens(manifest_message)
    remaining = max(int(available_tokens), 0)
    attachments: list[CompactRuntimeAttachment] = []
    if manifest_tokens <= remaining:
        attachments.append(
            CompactRuntimeAttachment(
                kind="recent_read_manifest",
                message=manifest_message,
                approximate_tokens=manifest_tokens,
                source_tool_call_ids=tuple(_read_tool_call_ids(unique)),
                optional=True,
            )
        )
        remaining -= manifest_tokens
    else:
        dropped.append({"kind": "recent_read_manifest", "reason": "shared_budget_exhausted"})
        return CompactRuntimeAttachmentSelection(tuple(attachments), tuple(dropped))

    if read_current is None or remaining <= 0:
        return CompactRuntimeAttachmentSelection(tuple(attachments), tuple(dropped))
    total_snippet_tokens = 0
    for item in unique:
        if not item.get("range_reliable"):
            dropped.append({"kind": "recent_read_snippet", "reason": "range_unavailable"})
            continue
        try:
            current = read_current(item["path"])
        except Exception:
            dropped.append({"kind": "recent_read_snippet", "reason": "read_denied_or_missing"})
            continue
        selected = _current_line_window(current, item)
        if not selected:
            dropped.append({"kind": "recent_read_snippet", "reason": "range_out_of_bounds"})
            continue
        max_tokens = min(
            remaining,
            RECENT_READ_SNIPPET_MAX_TOKENS_PER_RANGE,
            RECENT_READ_SNIPPET_MAX_TOKENS_TOTAL - total_snippet_tokens,
        )
        if max_tokens <= 0:
            dropped.append({"kind": "recent_read_snippet", "reason": "shared_budget_exhausted"})
            break
        built_snippet = _build_recent_read_snippet_message(
            item,
            selected,
            max_tokens=max_tokens,
        )
        if built_snippet is None:
            dropped.append({"kind": "recent_read_snippet", "reason": "shared_budget_exhausted"})
            break
        snippet_message, actual = built_snippet
        if actual > remaining:
            dropped.append({"kind": "recent_read_snippet", "reason": "shared_budget_exhausted"})
            break
        attachments.append(
            CompactRuntimeAttachment(
                kind="recent_read_snippet",
                message=snippet_message,
                approximate_tokens=actual,
                source_tool_call_ids=tuple(
                    item.get("tool_call_ids") or [item["tool_call_id"]]
                ),
                optional=True,
            )
        )
        remaining -= actual
        total_snippet_tokens += actual
    return CompactRuntimeAttachmentSelection(tuple(attachments), tuple(dropped))


def is_compact_runtime_attachment_message(message: BaseMessage) -> bool:
    metadata = getattr(message, "additional_kwargs", {}).get(
        COMPACT_RUNTIME_ATTACHMENT_METADATA_KEY
    )
    return isinstance(metadata, dict) and bool(metadata.get("kind"))


def _runtime_attachment_message(
    *,
    kind: str,
    content: str,
    source_tool_call_ids: list[str],
    metadata_payload: dict[str, Any] | None = None,
) -> HumanMessage:
    metadata = {
        "kind": kind,
        "hidden_for_transcript": True,
        "source_tool_call_ids": source_tool_call_ids,
    }
    if metadata_payload:
        metadata.update(metadata_payload)
    return HumanMessage(
        content=content,
        additional_kwargs={
            COMPACT_RUNTIME_ATTACHMENT_METADATA_KEY: metadata
        },
    )


def _collect_recent_reads(messages: list[BaseMessage]) -> list[dict[str, Any]]:
    calls: dict[str, dict[str, Any]] = {}
    completed: list[dict[str, Any]] = []
    for message in messages:
        carried_reads = _carried_recent_reads(message)
        if carried_reads:
            # Manifest entries are stored newest first. Keep the collector chronological so
            # the caller's final reverse continues to produce newest-first ordering.
            completed.extend(reversed(carried_reads))
        if isinstance(message, AIMessage):
            for call in message.tool_calls:
                if call.get("name") != "read_file" or not isinstance(call.get("args"), dict):
                    continue
                call_id = str(call.get("id") or "")
                path = str(call["args"].get("path") or "").strip()
                if not call_id or not path:
                    continue
                start = call["args"].get("start_line")
                max_lines = call["args"].get("max_lines")
                calls[call_id] = {
                    "tool_call_id": call_id,
                    "tool_call_ids": [call_id],
                    "path": path,
                    "requested_start_line": _positive_integer(start),
                    "requested_max_lines": _positive_integer(max_lines),
                    "requested_mode": str(call["args"].get("mode") or "window"),
                    "time": str(
                        getattr(message, "additional_kwargs", {}).get("timestamp_ms") or ""
                    ),
                }
        elif isinstance(message, ToolMessage):
            call_id = str(message.tool_call_id or "")
            if call_id in calls:
                record = _completed_read_record(
                    calls[call_id],
                    _tool_result_payload(message),
                )
                if record is not None:
                    completed.append(record)
    return completed


def _carried_recent_reads(message: BaseMessage) -> list[dict[str, Any]]:
    metadata = getattr(message, "additional_kwargs", {}).get(
        COMPACT_RUNTIME_ATTACHMENT_METADATA_KEY
    )
    if not isinstance(metadata, dict) or metadata.get("kind") != "recent_read_manifest":
        return []
    raw_reads = metadata.get("recent_reads")
    if not isinstance(raw_reads, list):
        return []
    result: list[dict[str, Any]] = []
    for item in raw_reads:
        if not isinstance(item, dict):
            continue
        tool_call_id = str(item.get("tool_call_id") or "").strip()
        path = str(item.get("path") or "").strip()
        if not tool_call_id or not path:
            continue
        start_line = _positive_integer(item.get("start_line"))
        end_line = _positive_integer(item.get("end_line"))
        range_reliable = bool(item.get("range_reliable")) and start_line is not None and (
            end_line is not None and end_line >= start_line
        )
        tool_call_ids = [
            str(value)
            for value in (item.get("tool_call_ids") or [tool_call_id])
            if str(value)
        ]
        result.append(
            {
                "tool_call_id": tool_call_id,
                "tool_call_ids": tool_call_ids or [tool_call_id],
                "path": path,
                "start_line": start_line,
                "end_line": end_line,
                "mode": str(item.get("mode") or "window"),
                "range_reliable": range_reliable,
                "range_source": str(item.get("range_source") or "legacy_unknown"),
                "time": str(item.get("time") or ""),
            }
        )
    return result


def _completed_read_record(
    requested: dict[str, Any],
    result: dict[str, Any] | None,
) -> dict[str, Any] | None:
    record = dict(requested)
    if isinstance(result, dict) and (
        result.get("ok") is False
        or str(result.get("status") or "").casefold() == "failed"
        or isinstance(result.get("error"), dict)
    ):
        return None
    if not isinstance(result, dict):
        return _requested_window_record(record)
    start_line = _positive_integer(result.get("start_line"))
    returned_lines = _non_negative_integer(result.get("returned_lines"))
    range_reliable = start_line is not None and returned_lines is not None
    end_line = (
        start_line + returned_lines - 1
        if range_reliable and returned_lines > 0
        else None
    )
    result_path = str(result.get("path") or "").strip()
    record.update(
        {
            "path": result_path or record["path"],
            "start_line": start_line,
            "end_line": end_line,
            "mode": str(result.get("mode") or requested.get("requested_mode") or "window"),
            "range_reliable": range_reliable and end_line is not None,
            "range_source": "tool_result" if range_reliable and end_line is not None else "",
        }
    )
    if returned_lines == 0:
        record["range_source"] = "tool_result_empty"
        return record
    return record if record["range_reliable"] else _requested_window_record(record)


def _requested_window_record(record: dict[str, Any]) -> dict[str, Any]:
    mode = str(record.get("mode") or record.get("requested_mode") or "window")
    if mode == "window":
        start_line = _positive_integer(record.get("requested_start_line")) or 1
        max_lines = min(
            _positive_integer(record.get("requested_max_lines")) or DEFAULT_MAX_LINES,
            MAX_MAX_LINES,
        )
        record.update(
            {
                "start_line": start_line,
                "end_line": start_line + max_lines - 1,
                "mode": mode,
                "range_reliable": True,
                "range_source": "request_window",
            }
        )
        return record
    record.update(
        {
            "start_line": None,
            "end_line": None,
            "mode": mode,
            "range_reliable": False,
            "range_source": "legacy_unknown",
        }
    )
    return record


def _tool_result_payload(message: ToolMessage) -> dict[str, Any] | None:
    if str(getattr(message, "status", "") or "").casefold() == "error":
        return {"ok": False, "status": "failed"}
    preserved = getattr(message, "additional_kwargs", {}).get(
        TRUNCATED_TOOL_RESULT_METADATA_KEY
    )
    if isinstance(preserved, dict):
        return dict(preserved)
    content = message.content
    if isinstance(content, str):
        try:
            parsed = json.loads(content)
        except (TypeError, ValueError):
            return None
        if isinstance(parsed, dict):
            nested = parsed.get("result")
            return nested if isinstance(nested, dict) else parsed
        return None
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            if isinstance(block.get("json"), dict):
                return dict(block["json"])
            text = block.get("text")
            if isinstance(text, str):
                try:
                    parsed = json.loads(text)
                except (TypeError, ValueError):
                    continue
                if isinstance(parsed, dict):
                    return parsed
    return None


def _append_or_merge_read_window(
    unique: list[dict[str, Any]],
    candidate: dict[str, Any],
) -> None:
    identity = str(candidate.get("path") or "").replace("\\", "/").casefold()
    for existing in unique:
        existing_identity = str(existing.get("path") or "").replace("\\", "/").casefold()
        if existing_identity != identity:
            continue
        if not existing.get("range_reliable") and candidate.get("range_reliable"):
            existing.clear()
            existing.update(dict(candidate))
            return
        if existing.get("range_reliable") and not candidate.get("range_reliable"):
            return
        if not existing.get("range_reliable") or not candidate.get("range_reliable"):
            return
        existing_start = int(existing["start_line"])
        existing_end = int(existing["end_line"])
        candidate_start = int(candidate["start_line"])
        candidate_end = int(candidate["end_line"])
        if candidate_end + 1 < existing_start or existing_end + 1 < candidate_start:
            continue
        existing["start_line"] = min(existing_start, candidate_start)
        existing["end_line"] = max(existing_end, candidate_end)
        existing["mode"] = (
            existing.get("mode")
            if existing.get("mode") == candidate.get("mode")
            else "merged"
        )
        existing["tool_call_ids"] = list(
            dict.fromkeys(
                [
                    *(existing.get("tool_call_ids") or [existing["tool_call_id"]]),
                    *(candidate.get("tool_call_ids") or [candidate["tool_call_id"]]),
                ]
            )
        )
        return
    unique.append(dict(candidate))


def _read_range_label(item: dict[str, Any]) -> str:
    if not item.get("range_reliable"):
        return "原读取范围不可可靠恢复"
    return f"第 {int(item['start_line'])}-{int(item['end_line'])} 行"


def _read_tool_call_ids(items: list[dict[str, Any]]) -> list[str]:
    return list(
        dict.fromkeys(
            str(call_id)
            for item in items
            for call_id in (item.get("tool_call_ids") or [item["tool_call_id"]])
            if str(call_id)
        )
    )


def _current_line_window(current: str, item: dict[str, Any]) -> str:
    start_line = int(item["start_line"])
    end_line = int(item["end_line"])
    lines = current.splitlines(keepends=True)
    start_index = min(max(start_line - 1, 0), len(lines))
    end_index = min(max(end_line, start_index), len(lines))
    return "".join(lines[start_index:end_index])


def _build_recent_read_snippet_message(
    item: dict[str, Any],
    selected: str,
    *,
    max_tokens: int,
) -> tuple[HumanMessage, int] | None:
    prefix = (
        f"当前文件片段：{item['path']}\n"
        f"恢复范围：{_read_range_label(item)}；内容来自压缩时的当前文件版本。\n\n"
    )
    source_ids = list(item.get("tool_call_ids") or [item["tool_call_id"]])

    def build(char_count: int) -> tuple[HumanMessage, int]:
        suffix = (
            "\n...[文件片段按共享预算截断]"
            if char_count < len(selected)
            else ""
        )
        message = _runtime_attachment_message(
            kind="recent_read_snippet",
            content=f"{prefix}{selected[:char_count]}{suffix}",
            source_tool_call_ids=source_ids,
        )
        return message, approximate_message_tokens(message)

    low = 1
    high = len(selected)
    best: tuple[HumanMessage, int] | None = None
    while low <= high:
        middle = (low + high) // 2
        candidate = build(middle)
        if candidate[1] <= max_tokens:
            best = candidate
            low = middle + 1
        else:
            high = middle - 1
    return best


def _positive_integer(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _non_negative_integer(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _is_instruction_path(path: str) -> bool:
    normalized = path.replace("\\", "/").casefold()
    name = normalized.rsplit("/", 1)[-1]
    return name in {"skill.md", "keydex.md", "agents.md"}
