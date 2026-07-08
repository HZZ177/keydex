from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class A2UIResumeContext:
    payloads_by_tool_call_id: dict[str, dict[str, Any]] = field(default_factory=dict)
    payloads_by_render_key: dict[str, list[dict[str, Any]]] = field(default_factory=dict)

    def consume(
        self,
        *,
        render_key: str,
        tool_call_id: str | None = None,
    ) -> dict[str, Any] | None:
        cleaned_tool_call_id = str(tool_call_id or "").strip()
        if cleaned_tool_call_id:
            payload = self.payloads_by_tool_call_id.pop(cleaned_tool_call_id, None)
            if payload is None:
                return None
            self._remove_render_key_alias(render_key, payload)
            return dict(payload)

        if self._has_tool_call_payload_for_render_key(render_key):
            return None
        queue = self.payloads_by_render_key.get(render_key) or []
        if not queue:
            return None
        payload = queue.pop(0)
        if queue:
            self.payloads_by_render_key[render_key] = queue
        else:
            self.payloads_by_render_key.pop(render_key, None)
        return dict(payload)

    def _has_tool_call_payload_for_render_key(self, render_key: str) -> bool:
        queue = self.payloads_by_render_key.get(render_key) or []
        return any(
            str(payload.get("render_key") or "") == render_key or payload in queue
            for payload in self.payloads_by_tool_call_id.values()
        )

    def _remove_render_key_alias(self, render_key: str, payload: dict[str, Any]) -> None:
        queue = self.payloads_by_render_key.get(render_key)
        if not queue:
            return
        remaining = [item for item in queue if item != payload]
        if remaining:
            self.payloads_by_render_key[render_key] = remaining
        else:
            self.payloads_by_render_key.pop(render_key, None)


def build_a2ui_resume_context(
    *,
    payloads_by_tool_call_id: dict[str, dict[str, Any]] | None = None,
    payloads_by_render_key: dict[str, list[dict[str, Any]]] | None = None,
) -> A2UIResumeContext:
    return A2UIResumeContext(
        payloads_by_tool_call_id={
            key: dict(value)
            for key, value in (payloads_by_tool_call_id or {}).items()
            if key
        },
        payloads_by_render_key={
            key: [dict(item) for item in value]
            for key, value in (payloads_by_render_key or {}).items()
            if key
        },
    )
