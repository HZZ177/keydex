from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage

from backend.app.agent.context_compression_segments import approximate_message_tokens
from backend.app.command_approval import load_command_settings
from backend.app.storage import SessionRecord, StorageRepositories
from backend.app.tools.base import ToolExecutionContext
from backend.app.tools.file_access import resolve_file_access_path

COMPACT_RUNTIME_ATTACHMENT_METADATA_KEY = "keydex_compact_runtime_attachment"
RECENT_READ_MANIFEST_MAX_ENTRIES = 5
RECENT_READ_SNIPPET_MAX_TOKENS_PER_FILE = 10_000
RECENT_READ_SNIPPET_MAX_TOKENS_TOTAL = 50_000
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
        if item["tool_call_id"] not in (tail_tool_call_ids or set())
        and not _is_instruction_path(item["path"])
    ]
    unique: list[dict[str, str]] = []
    seen_paths: set[str] = set()
    for item in reads:
        identity = item["path"].replace("\\", "/").casefold()
        if identity in seen_paths:
            continue
        seen_paths.add(identity)
        unique.append(item)
        if len(unique) >= RECENT_READ_MANIFEST_MAX_ENTRIES:
            break

    dropped: list[dict[str, str]] = []
    if not unique:
        return CompactRuntimeAttachmentSelection((), ())
    manifest_payload = [
        {
            "path": item["path"],
            "purpose_or_range": item["range"],
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
        source_tool_call_ids=[item["tool_call_id"] for item in unique],
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
                source_tool_call_ids=tuple(item["tool_call_id"] for item in unique),
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
        try:
            current = read_current(item["path"])
        except Exception:
            dropped.append({"kind": "recent_read_snippet", "reason": "read_denied_or_missing"})
            continue
        max_tokens = min(
            remaining,
            RECENT_READ_SNIPPET_MAX_TOKENS_PER_FILE,
            RECENT_READ_SNIPPET_MAX_TOKENS_TOTAL - total_snippet_tokens,
        )
        if max_tokens <= 0:
            dropped.append({"kind": "recent_read_snippet", "reason": "shared_budget_exhausted"})
            break
        max_chars = max_tokens * 2
        truncated = len(current) > max_chars
        snippet = current[:max_chars]
        suffix = "\n...[文件片段按共享预算截断]" if truncated else ""
        snippet_message = _runtime_attachment_message(
            kind="recent_read_snippet",
            content=f"当前文件片段：{item['path']}\n\n{snippet}{suffix}",
            source_tool_call_ids=[item["tool_call_id"]],
        )
        actual = approximate_message_tokens(snippet_message)
        if actual > remaining:
            dropped.append({"kind": "recent_read_snippet", "reason": "shared_budget_exhausted"})
            break
        attachments.append(
            CompactRuntimeAttachment(
                kind="recent_read_snippet",
                message=snippet_message,
                approximate_tokens=actual,
                source_tool_call_ids=(item["tool_call_id"],),
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


def _collect_recent_reads(messages: list[BaseMessage]) -> list[dict[str, str]]:
    calls: dict[str, dict[str, str]] = {}
    completed: list[dict[str, str]] = []
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
                start = call["args"].get("start_line", call["args"].get("offset"))
                end = call["args"].get("end_line", call["args"].get("limit"))
                calls[call_id] = {
                    "tool_call_id": call_id,
                    "path": path,
                    "range": f"{start or 'start'}..{end or 'end'}",
                    "time": str(
                        getattr(message, "additional_kwargs", {}).get("timestamp_ms") or ""
                    ),
                }
        elif isinstance(message, ToolMessage):
            call_id = str(message.tool_call_id or "")
            if call_id in calls:
                completed.append(calls[call_id])
    return completed


def _carried_recent_reads(message: BaseMessage) -> list[dict[str, str]]:
    metadata = getattr(message, "additional_kwargs", {}).get(
        COMPACT_RUNTIME_ATTACHMENT_METADATA_KEY
    )
    if not isinstance(metadata, dict) or metadata.get("kind") != "recent_read_manifest":
        return []
    raw_reads = metadata.get("recent_reads")
    if not isinstance(raw_reads, list):
        return []
    result: list[dict[str, str]] = []
    for item in raw_reads:
        if not isinstance(item, dict):
            continue
        tool_call_id = str(item.get("tool_call_id") or "").strip()
        path = str(item.get("path") or "").strip()
        if not tool_call_id or not path:
            continue
        result.append(
            {
                "tool_call_id": tool_call_id,
                "path": path,
                "range": str(item.get("range") or "start..end"),
                "time": str(item.get("time") or ""),
            }
        )
    return result


def _is_instruction_path(path: str) -> bool:
    normalized = path.replace("\\", "/").casefold()
    name = normalized.rsplit("/", 1)[-1]
    return name in {"skill.md", "keydex.md", "agents.md"}
