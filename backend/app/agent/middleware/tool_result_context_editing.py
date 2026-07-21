from __future__ import annotations

from pathlib import Path
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import RemoveMessage
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from backend.app.agent.context_governance_observability import log_context_governance_metric
from backend.app.agent.middleware.common import _state_messages
from backend.app.agent.tool_result_context_editing import (
    context_for_context_editing,
    select_tool_result_context_candidates,
    tombstone_tool_result,
)
from backend.app.agent.tool_results.artifact_repository import ToolResultArtifactRepository
from backend.app.core.logger import logger
from backend.app.core.request_context import get_session_id, get_turn_index, get_user_id
from backend.app.storage import StorageRepositories


class ToolResultContextEditingMiddleware(AgentMiddleware):
    """Low-frequency, artifact-backed clearing of old eligible ToolMessages."""

    def __init__(self, *, repositories: StorageRepositories, data_dir: Path | str) -> None:
        self.repositories = repositories
        self.data_dir = Path(data_dir).resolve(strict=False)
        self.artifacts = ToolResultArtifactRepository(
            repositories=repositories,
            data_dir=self.data_dir,
        )

    async def abefore_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        del runtime
        messages = _state_messages(state)
        if not messages:
            return None
        plan = select_tool_result_context_candidates(messages)
        if not plan.candidates:
            if plan.reclaimable_tokens:
                log_context_governance_metric(
                    "context_editing_skipped",
                    session_id=get_session_id(),
                    reason_code="reclaim_threshold_not_met",
                    reclaimable_tokens=plan.reclaimable_tokens,
                    threshold_tokens=100_000,
                    invalid_protocol_units=plan.invalid_protocol_units,
                )
            return None
        session_id = str(get_session_id() or "").strip()
        user_id = str(get_user_id() or "").strip()
        if not session_id or not user_id:
            return None
        context = context_for_context_editing(
            session_id=session_id,
            user_id=user_id,
            data_dir=self.data_dir,
            turn_index=get_turn_index() or 0,
            repositories=self.repositories,
        )
        updated = list(messages)
        cleared = 0
        reclaimed = 0
        tombstone_tokens = 0
        for candidate in plan.candidates:
            message = updated[candidate.message_index]
            try:
                updated[candidate.message_index] = tombstone_tool_result(
                    message,
                    repository=self.artifacts,
                    context=context,
                )
            except Exception as exc:
                logger.warning(
                    "[ToolResultContextEditing] artifact-before-clear failed; "
                    "keeping result unchanged | "
                    f"session_id={session_id} | tool_call_id={candidate.tool_call_id} | "
                    f"reason={type(exc).__name__}"
                )
                continue
            cleared += 1
            reclaimed += candidate.approximate_tokens
            tombstone_tokens += max(
                len(str(updated[candidate.message_index].content).encode("utf-8")) // 4,
                1,
            )
        if not cleared:
            return None
        logger.info(
            "[ToolResultContextEditing] old tool results cleared | "
            f"session_id={session_id} | cleared={cleared} | "
            f"approximate_reclaimed_tokens={reclaimed} | "
            f"protected_recent_results={len(plan.protected_tool_call_ids)}"
        )
        log_context_governance_metric(
            "context_editing_completed",
            session_id=session_id,
            candidate_results=len(plan.candidates),
            cleared_results=cleared,
            skipped_results=len(plan.candidates) - cleared,
            original_tool_result_tokens=reclaimed,
            tombstone_tokens=tombstone_tokens,
            reclaimed_tokens=max(reclaimed - tombstone_tokens, 0),
            protected_recent_results=len(plan.protected_tool_call_ids),
            invalid_protocol_units=plan.invalid_protocol_units,
        )
        return {"messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), *updated]}
