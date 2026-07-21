from __future__ import annotations

from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import RemoveMessage, SystemMessage
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from backend.app.agent.context_compression_segments import approximate_message_tokens
from backend.app.agent.state import (
    CONTEXT_COMPRESSION_DIAGNOSTICS_STATE_KEY,
    build_pending_skill_activations_reset_update,
)
from backend.app.agent.tool_results.budgets import GLOBAL_TOOL_RESULT_BUDGET_BYTES, utf8_bytes
from backend.app.core.logger import logger


class SkillActivationInjectionMiddleware(AgentMiddleware):
    async def abefore_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        pending = list((state or {}).get("pending_skill_activations") or [])
        if not pending:
            return None

        messages = list((state or {}).get("messages") or [])
        injected_messages: list[SystemMessage] = []
        injected_skill_names: list[str] = []
        for item in pending:
            if not isinstance(item, dict):
                continue
            content = str(item.get("content") or "").strip()
            if not content:
                continue
            skill_name = str(item.get("skill_name") or "").strip()
            if utf8_bytes(content) > GLOBAL_TOOL_RESULT_BUDGET_BYTES:
                logger.warning(
                    "[SkillActivationInjectionMiddleware] skipped oversized legacy activation | "
                    f"skill={skill_name or '-'} | bytes={utf8_bytes(content)}"
                )
                continue
            injected_messages.append(SystemMessage(content=content))
            if skill_name:
                injected_skill_names.append(skill_name)

        reset_update = build_pending_skill_activations_reset_update()
        if not injected_messages:
            return reset_update

        logger.info(
            "[SkillActivationInjectionMiddleware] injected skill activation messages | "
            f"count={len(injected_messages)} | skills={injected_skill_names}"
        )
        update: dict[str, Any] = {
            "messages": [
                RemoveMessage(id=REMOVE_ALL_MESSAGES),
                *messages,
                *injected_messages,
            ],
            **reset_update,
        }
        diagnostics = (state or {}).get(CONTEXT_COMPRESSION_DIAGNOSTICS_STATE_KEY)
        if isinstance(diagnostics, dict) and diagnostics.get("boundary_id"):
            actual_tokens = sum(
                approximate_message_tokens(message) for message in injected_messages
            )
            reserve = max(int(diagnostics.get("deferred_replay_reserve") or 0), 0)
            update[CONTEXT_COMPRESSION_DIAGNOSTICS_STATE_KEY] = {
                **diagnostics,
                "deferred_replay_actual_tokens": actual_tokens,
                "deferred_replay_delta_tokens": actual_tokens - reserve,
                "materialization_status": "materialized",
            }
        return update
