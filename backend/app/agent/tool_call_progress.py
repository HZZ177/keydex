from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from difflib import unified_diff
from typing import Any, Protocol


@dataclass(slots=True)
class ToolCallChunkDelta:
    key: str
    tool_call_id: str
    index: int | None
    name: str
    args: str | dict[str, Any] | None


@dataclass(slots=True)
class ToolCallChunkState:
    key: str
    tool_call_id: str = ""
    index: int | None = None
    model_run_id: str = ""
    name: str = ""
    args_text: str = ""
    args: dict[str, Any] = field(default_factory=dict)
    last_args_delta: str = ""
    last_progress_fingerprint: str = ""
    bound_run_id: str = ""


class ToolProgressCollector(Protocol):
    tool_names: frozenset[str]

    def collect(self, state: ToolCallChunkState) -> dict[str, Any] | None: ...


class ToolCallChunkPipeline:
    def __init__(
        self,
        collectors: list[ToolProgressCollector] | None = None,
    ) -> None:
        self._states: dict[str, ToolCallChunkState] = {}
        self._index_keys: dict[str, str] = {}
        self._loose_index_keys: dict[int, str] = {}
        self._run_keys: dict[str, str] = {}
        self._collectors: dict[str, ToolProgressCollector] = {}
        for collector in collectors or default_collectors():
            for tool_name in collector.tool_names:
                self._collectors[tool_name] = collector

    def process_chunk(self, chunk: Any, *, model_run_id: str) -> list[dict[str, Any]]:
        progress: list[dict[str, Any]] = []
        for delta in extract_tool_call_chunks(chunk, model_run_id=model_run_id):
            index_key = f"{model_run_id}:{delta.index}" if delta.index is not None else ""
            loose_index_key = delta.index if delta.index is not None else None
            can_continue_loose_index = (
                loose_index_key is not None
                and not delta.tool_call_id
                and not delta.name
            )
            state_key = delta.key
            if delta.tool_call_id and index_key:
                existing_key = self._index_keys.get(index_key)
                if existing_key:
                    state_key = existing_key
                else:
                    self._index_keys[index_key] = delta.key
            elif index_key:
                state_key = self._index_keys.get(index_key, "")
                if not state_key and can_continue_loose_index:
                    state_key = self._loose_index_keys.get(loose_index_key, "")
                state_key = state_key or delta.key
                self._index_keys.setdefault(index_key, state_key)
            if loose_index_key is not None and delta.name:
                self._loose_index_keys.setdefault(loose_index_key, state_key)

            state = self._states.setdefault(
                state_key,
                ToolCallChunkState(
                    key=state_key,
                    tool_call_id=delta.tool_call_id,
                    index=delta.index,
                    model_run_id=model_run_id,
                ),
            )
            if not state.model_run_id:
                state.model_run_id = model_run_id
            if delta.tool_call_id:
                state.tool_call_id = delta.tool_call_id
            if delta.index is not None:
                state.index = delta.index
            if delta.name:
                state.name = delta.name
            if isinstance(delta.args, str):
                state.last_args_delta = delta.args
                state.args_text += delta.args
                state.args.update(parse_partial_json_object(state.args_text))
            elif isinstance(delta.args, dict):
                state.args.update(delta.args)
                merged_args_text = merge_json_text(state.args_text, delta.args)
                state.last_args_delta = merged_args_text if not state.args_text else ""
                state.args_text = merged_args_text
            else:
                state.last_args_delta = ""

            collector = self._collectors.get(state.name)
            if collector is None:
                continue
            payload = collector.collect(state)
            if payload is None:
                continue
            fingerprint = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
            if fingerprint == state.last_progress_fingerprint:
                continue
            state.last_progress_fingerprint = fingerprint
            progress.append(payload)
        return progress

    def bind_tool_run(
        self,
        *,
        run_id: str,
        tool_name: str,
        params: Any,
    ) -> str:
        if not run_id or not tool_name:
            return ""
        if existing_key := self._run_keys.get(run_id):
            return self._tool_call_id_for_key(existing_key)

        params_record = params if isinstance(params, dict) else {}
        candidates = [
            (score, state)
            for state in reversed(list(self._states.values()))
            if state.name == tool_name
            and (score := tool_state_match_score(state, params_record)) > 0
        ]
        if not candidates:
            return ""

        candidates.sort(key=lambda item: item[0], reverse=True)
        state = candidates[0][1]
        state.bound_run_id = run_id
        self._run_keys[run_id] = state.key
        if state.index is not None:
            self._loose_index_keys.pop(state.index, None)
        return state.tool_call_id or state.key

    def tool_call_id_for_run(self, run_id: str) -> str:
        if not run_id:
            return ""
        return self._tool_call_id_for_key(self._run_keys.get(run_id, ""))

    def _tool_call_id_for_key(self, key: str) -> str:
        if not key:
            return ""
        state = self._states.get(key)
        if state is None:
            return ""
        return state.tool_call_id or state.key


class ApplyPatchProgressCollector:
    tool_names = frozenset({"edit_file", "apply_patch"})

    def collect(self, state: ToolCallChunkState) -> dict[str, Any] | None:
        patch = string_value(state.args.get("patch"))
        if not patch:
            return None
        files = mark_file_changes_as_operation(
            parse_apply_patch_file_changes(patch),
            operation="update",
        )
        if not files:
            return None
        return progress_payload(state=state, files=files, phase="streaming")


class WriteFileProgressCollector:
    tool_names = frozenset({"create_file", "write_file"})

    def collect(self, state: ToolCallChunkState) -> dict[str, Any] | None:
        path = string_value(state.args.get("path"))
        if not path:
            return None
        content = string_value(state.args.get("content"))
        file_change = normalize_file_change(
            path=path,
            operation="add",
            added_lines=count_text_lines(content),
            deleted_lines=0,
            diff=build_text_diff(
                path=path,
                before="",
                after=content,
                operation="add",
            ),
        )
        return progress_payload(state=state, files=[file_change], phase="streaming")


def default_collectors() -> list[ToolProgressCollector]:
    return [
        ApplyPatchProgressCollector(),
        WriteFileProgressCollector(),
    ]


def extract_tool_call_chunks(chunk: Any, *, model_run_id: str) -> list[ToolCallChunkDelta]:
    raw_chunks = getattr(chunk, "tool_call_chunks", None)
    if raw_chunks is None:
        additional_kwargs = getattr(chunk, "additional_kwargs", {}) or {}
        raw_chunks = additional_kwargs.get("tool_call_chunks") or additional_kwargs.get(
            "tool_calls"
        )
    if not isinstance(raw_chunks, list):
        return []
    return [
        delta
        for raw_index, raw in enumerate(raw_chunks)
        if (delta := normalize_tool_call_chunk(raw, raw_index=raw_index, model_run_id=model_run_id))
        is not None
    ]


def normalize_tool_call_chunk(
    raw: Any,
    *,
    raw_index: int,
    model_run_id: str,
) -> ToolCallChunkDelta | None:
    record = raw if isinstance(raw, dict) else object_to_record(raw)
    if not record:
        return None
    function = record.get("function") if isinstance(record.get("function"), dict) else {}
    raw_index_value = record.get("index", raw_index)
    index = raw_index_value if isinstance(raw_index_value, int) else raw_index
    tool_call_id = string_value(record.get("id")) or string_value(record.get("tool_call_id"))
    name = string_value(record.get("name")) or string_value(function.get("name"))
    args = record.get("args", record.get("arguments", function.get("arguments")))
    if args is not None and not isinstance(args, str | dict):
        args = str(args)
    key = tool_call_id or f"{model_run_id}:{index}"
    return ToolCallChunkDelta(
        key=key,
        tool_call_id=tool_call_id,
        index=index,
        name=name,
        args=args,
    )


def object_to_record(value: Any) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key in ("id", "tool_call_id", "index", "name", "args", "arguments", "function"):
        if hasattr(value, key):
            result[key] = getattr(value, key)
    return result


def merge_json_text(current: str, patch: dict[str, Any]) -> str:
    if not current:
        return json.dumps(patch, ensure_ascii=False)
    try:
        parsed = json.loads(current)
    except json.JSONDecodeError:
        return current
    if isinstance(parsed, dict):
        parsed.update(patch)
        return json.dumps(parsed, ensure_ascii=False)
    return current


def parse_partial_json_object(value: str) -> dict[str, Any]:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        return parsed

    result: dict[str, Any] = {}
    for key in ("patch", "path", "content", "mode"):
        extracted = extract_partial_json_string_field(value, key)
        if extracted is not None:
            result[key] = extracted
    return result


def extract_partial_json_string_field(value: str, field: str) -> str | None:
    match = re.search(rf'"{re.escape(field)}"\s*:', value)
    if not match:
        return None
    index = match.end()
    while index < len(value) and value[index].isspace():
        index += 1
    if index >= len(value) or value[index] != '"':
        return None
    index += 1
    chars: list[str] = []
    escaping = False
    while index < len(value):
        char = value[index]
        index += 1
        if escaping:
            chars.append(decode_json_escape(char))
            escaping = False
            continue
        if char == "\\":
            escaping = True
            continue
        if char == '"':
            return "".join(chars)
        chars.append(char)
    return "".join(chars)


def decode_json_escape(char: str) -> str:
    return {
        '"': '"',
        "\\": "\\",
        "/": "/",
        "b": "\b",
        "f": "\f",
        "n": "\n",
        "r": "\r",
        "t": "\t",
    }.get(char, char)


def parse_apply_patch_file_changes(patch: str) -> list[dict[str, Any]]:
    stats: dict[str, dict[str, Any]] = {}
    current_path = ""
    current_operation = ""
    current_move_to = ""
    for line in patch.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if line.startswith("*** Update File: "):
            current_path = line.removeprefix("*** Update File: ").strip()
            current_operation = "update"
            current_move_to = ""
            ensure_file_change(stats, current_path, current_operation)
            continue
        if line.startswith("*** Move to: ") and current_path:
            current_move_to = line.removeprefix("*** Move to: ").strip()
            current_operation = "move"
            file_change = ensure_file_change(stats, current_path, "move")
            file_change["change_type"] = "move"
            file_change["old_path"] = current_path
            file_change["new_path"] = current_move_to
            file_change["path"] = current_move_to or current_path
            diff_lines = file_change.setdefault(
                "_diff_lines",
                [f"--- a/{current_path}", f"+++ b/{current_move_to or current_path}"],
            )
            if isinstance(diff_lines, list):
                diff_lines.append(line)
            continue
        if line.startswith("*** Delete File: "):
            current_path = line.removeprefix("*** Delete File: ").strip()
            current_operation = "delete"
            current_move_to = ""
            ensure_file_change(stats, current_path, current_operation)
            continue
        if line.startswith("*** "):
            current_path = ""
            current_operation = ""
            current_move_to = ""
            continue
        if not current_path:
            continue
        file_change = ensure_file_change(stats, current_path, current_operation)
        if current_move_to:
            file_change["path"] = current_move_to
        diff_lines = file_change.setdefault(
            "_diff_lines",
            [f"--- a/{current_path}", f"+++ b/{current_move_to}"]
            if current_move_to
            else diff_header(current_path, current_operation),
        )
        if isinstance(diff_lines, list):
            diff_lines.append(line)
        if line.startswith("+") and not line.startswith("+++"):
            file_change["added_lines"] += 1
        elif line.startswith("-") and not line.startswith("---"):
            file_change["deleted_lines"] += 1

    changes: list[dict[str, Any]] = []
    for change in stats.values():
        diff_lines = change.pop("_diff_lines", [])
        if isinstance(diff_lines, list) and diff_lines:
            change["diff"] = "\n".join(diff_lines)
        changes.append(finalize_file_change(change))
    return changes


def diff_header(path: str, operation: str) -> list[str]:
    if operation == "delete":
        return [f"--- a/{path}", "+++ /dev/null"]
    return [f"--- a/{path}", f"+++ b/{path}"]


def build_text_diff(
    *,
    path: str,
    before: str,
    after: str,
    operation: str = "update",
) -> str:
    from_file = "/dev/null" if operation == "add" else f"a/{path}"
    to_file = "/dev/null" if operation == "delete" else f"b/{path}"
    return "\n".join(
        unified_diff(
            before.splitlines(),
            after.splitlines(),
            fromfile=from_file,
            tofile=to_file,
            lineterm="",
        )
    )


def ensure_file_change(
    stats: dict[str, dict[str, Any]],
    path: str,
    operation: str,
) -> dict[str, Any]:
    file_change = stats.setdefault(
        path or "未知文件",
        {
            "path": path or "未知文件",
            "operation": operation,
            "added_lines": 0,
            "deleted_lines": 0,
        },
    )
    if operation and file_change.get("operation") != "delete":
        file_change["operation"] = operation
    return file_change


def normalize_file_change(
    *,
    path: str,
    operation: str = "",
    added_lines: int = 0,
    deleted_lines: int = 0,
    diff: str = "",
) -> dict[str, Any]:
    return finalize_file_change(
        {
            "path": path,
            "operation": operation,
            "added_lines": max(0, int(added_lines or 0)),
            "deleted_lines": max(0, int(deleted_lines or 0)),
            **({"diff": diff} if diff else {}),
        }
    )


def finalize_file_change(change: dict[str, Any]) -> dict[str, Any]:
    added = max(0, int(change.get("added_lines") or change.get("additions") or 0))
    deleted = max(
        0,
        int(
            change.get("deleted_lines")
            or change.get("removed_lines")
            or change.get("deletions")
            or 0
        ),
    )
    result = dict(change)
    result["added_lines"] = added
    result["deleted_lines"] = deleted
    result["removed_lines"] = deleted
    result["additions"] = added
    result["deletions"] = deleted
    return result


def mark_file_changes_as_operation(
    changes: list[dict[str, Any]],
    *,
    operation: str,
) -> list[dict[str, Any]]:
    return [finalize_file_change({**change, "operation": operation}) for change in changes]


def progress_payload(
    *,
    state: ToolCallChunkState,
    files: list[dict[str, Any]],
    phase: str,
) -> dict[str, Any]:
    return {
        "tool": state.name,
        "tool_name": state.name,
        "tool_call_id": state.tool_call_id or state.key,
        "run_id": state.tool_call_id or state.key,
        "index": state.index,
        "params": dict(state.args),
        "files": files,
        "phase": phase,
        "status": "running",
    }


def count_text_lines(value: str) -> int:
    if not value:
        return 0
    return len(value.splitlines())


def string_value(value: Any) -> str:
    return value if isinstance(value, str) else ""


def tool_state_match_score(state: ToolCallChunkState, params: dict[str, Any]) -> int:
    if not state.args:
        return 1 if not params else 0
    if not params:
        return 1
    if jsonable_equal(state.args, params):
        return 1000

    score = 0
    for key in ("patch", "content"):
        if (
            key in state.args
            and key in params
            and jsonable_equal(state.args.get(key), params.get(key))
        ):
            score += 300
    if (
        "path" in state.args
        and "path" in params
        and string_value(state.args.get("path")) == string_value(params.get("path"))
    ):
        score += 200
    state_patch_paths = patch_paths(string_value(state.args.get("patch")))
    params_patch_paths = patch_paths(string_value(params.get("patch")))
    if (
        state_patch_paths
        and params_patch_paths
        and state_patch_paths.intersection(params_patch_paths)
    ):
        score += 120
    return score


def jsonable_equal(left: Any, right: Any) -> bool:
    return json.dumps(left, ensure_ascii=False, sort_keys=True, default=str) == json.dumps(
        right,
        ensure_ascii=False,
        sort_keys=True,
        default=str,
    )


def patch_paths(patch: str) -> set[str]:
    paths: set[str] = set()
    for line in patch.splitlines():
        match = re.match(r"^\*\*\* (?:(?:Update|Delete) File|Move to):\s+(.+)$", line.strip())
        if match:
            paths.add(match.group(1).strip())
    return paths
