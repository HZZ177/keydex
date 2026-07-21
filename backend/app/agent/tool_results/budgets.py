from __future__ import annotations

from dataclasses import dataclass
from typing import Any

GLOBAL_TOOL_RESULT_BUDGET_BYTES = 32 * 1024


@dataclass(frozen=True, slots=True)
class ToolResultPolicy:
    """Code-owned tool-result policy; intentionally not user configurable."""

    budget_bytes: int = GLOBAL_TOOL_RESULT_BUDGET_BYTES
    native_pagination: bool = False
    breadth_first_compaction: bool = False
    persist_on_truncate: bool = False
    persist_before_clear: bool = False
    must_be_complete: bool = False
    never_clear: bool = False

    def __post_init__(self) -> None:
        if self.budget_bytes <= 0 or self.budget_bytes > GLOBAL_TOOL_RESULT_BUDGET_BYTES:
            raise ValueError("tool result budget must be within the global 32KB boundary")


_GENERIC_POLICY = ToolResultPolicy(persist_on_truncate=True)

_POLICIES: dict[str, ToolResultPolicy] = {
    "read_file": ToolResultPolicy(
        budget_bytes=24 * 1024,
        native_pagination=True,
        persist_on_truncate=True,
        persist_before_clear=True,
    ),
    "list_dir": ToolResultPolicy(
        budget_bytes=10 * 1024,
        native_pagination=True,
        breadth_first_compaction=True,
        persist_before_clear=True,
    ),
    "search_text": ToolResultPolicy(
        budget_bytes=32 * 1024,
        native_pagination=True,
        breadth_first_compaction=True,
        persist_on_truncate=True,
        persist_before_clear=True,
    ),
    "grep_files": ToolResultPolicy(
        budget_bytes=24 * 1024,
        native_pagination=True,
        breadth_first_compaction=True,
        persist_on_truncate=True,
        persist_before_clear=True,
    ),
    "search_files": ToolResultPolicy(
        budget_bytes=10 * 1024,
        native_pagination=True,
        breadth_first_compaction=True,
        persist_on_truncate=True,
        persist_before_clear=True,
    ),
    "read_tool_result": ToolResultPolicy(
        budget_bytes=32 * 1024,
        native_pagination=True,
        never_clear=True,
    ),
    "run_git_bash": ToolResultPolicy(
        budget_bytes=24 * 1024,
        persist_on_truncate=True,
        persist_before_clear=True,
    ),
    "run_cmd": ToolResultPolicy(
        budget_bytes=24 * 1024,
        persist_on_truncate=True,
        persist_before_clear=True,
    ),
    "run_powershell": ToolResultPolicy(
        budget_bytes=24 * 1024,
        persist_on_truncate=True,
        persist_before_clear=True,
    ),
    "create_file": ToolResultPolicy(never_clear=True),
    "write_file": ToolResultPolicy(never_clear=True),
    "edit_file": ToolResultPolicy(never_clear=True),
    "delete_file": ToolResultPolicy(never_clear=True),
    "move_file": ToolResultPolicy(never_clear=True),
    "apply_patch": ToolResultPolicy(never_clear=True),
    "web_search": ToolResultPolicy(
        persist_on_truncate=True,
        persist_before_clear=True,
    ),
    "web_fetch": ToolResultPolicy(
        persist_on_truncate=True,
        persist_before_clear=True,
    ),
    "delegate_subagent": ToolResultPolicy(
        persist_on_truncate=True,
        never_clear=True,
    ),
    "continue_subagent": ToolResultPolicy(
        persist_on_truncate=True,
        never_clear=True,
    ),
    "load_skill": ToolResultPolicy(must_be_complete=True, never_clear=True),
}


def get_tool_result_policy(
    tool_name: str,
    *,
    metadata: dict[str, Any] | None = None,
) -> ToolResultPolicy:
    normalized = str(tool_name or "").strip()
    if normalized in _POLICIES:
        return _POLICIES[normalized]
    if (
        normalized.startswith("mcp__")
        or normalized.startswith("mcp_")
        or isinstance((metadata or {}).get("mcp"), dict)
    ):
        return ToolResultPolicy(persist_on_truncate=True, persist_before_clear=True)
    return _GENERIC_POLICY


def utf8_bytes(value: str | bytes) -> int:
    if isinstance(value, bytes):
        return len(value)
    return len(str(value).encode("utf-8"))


def approximate_tokens(value: str | bytes | int) -> int:
    byte_count = value if isinstance(value, int) else utf8_bytes(value)
    return max(0, (byte_count + 3) // 4)
