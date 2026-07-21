from __future__ import annotations

import json
from typing import Any

from backend.app.core.logger import logger

_SAFE_METRIC_FIELDS = frozenset(
    {
        "tool",
        "session_id",
        "trace_id",
        "tool_call_id",
        "classification",
        "reason_code",
        "logical_query_id",
        "page_index",
        "calls_per_logical_query",
        "continuation_used",
        "wide_discovery_count",
        "wide_discovery_limit",
        "exception_type",
        "full_bytes",
        "model_bytes",
        "approximate_full_tokens",
        "approximate_model_tokens",
        "budget_bytes",
        "truncated",
        "artifact_id",
        "artifact_complete",
        "returned_identities",
        "omitted_identities",
        "has_continuation",
        "reclaimable_tokens",
        "threshold_tokens",
        "invalid_protocol_units",
        "candidate_results",
        "cleared_results",
        "skipped_results",
        "original_tool_result_tokens",
        "tombstone_tokens",
        "reclaimed_tokens",
        "protected_recent_results",
    }
)


def log_context_governance_metric(event: str, **fields: Any) -> None:
    """Emit payload-free structured diagnostics for context-governance decisions."""

    safe = {
        "schema_version": "keydex.context_governance_metric.v1",
        "event": str(event),
        **{
            str(key): value
            for key, value in fields.items()
            if key in _SAFE_METRIC_FIELDS
            and (value is None or isinstance(value, (str, int, float, bool)))
        },
    }
    logger.info(
        "[ContextGovernanceMetric] "
        + json.dumps(safe, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    )
