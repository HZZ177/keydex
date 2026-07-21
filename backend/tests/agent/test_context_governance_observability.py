from __future__ import annotations

import json
from types import SimpleNamespace

from backend.app.agent import context_governance_observability as observability


def test_context_governance_metric_is_versioned_and_payload_free(monkeypatch) -> None:
    lines: list[str] = []
    monkeypatch.setattr(observability, "logger", SimpleNamespace(info=lines.append))

    observability.log_context_governance_metric(
        "tool_result_projection",
        tool="search_text",
        session_id="session-1",
        full_bytes=400_000,
        model_bytes=32_000,
        query="top secret query",
        task="top secret task",
        path="C:/secret/file.txt",
        full_payload="top secret payload",
        args={"query": "nested secret"},
    )

    assert len(lines) == 1
    prefix = "[ContextGovernanceMetric] "
    assert lines[0].startswith(prefix)
    payload = json.loads(lines[0][len(prefix) :])
    assert payload == {
        "schema_version": "keydex.context_governance_metric.v1",
        "event": "tool_result_projection",
        "tool": "search_text",
        "session_id": "session-1",
        "full_bytes": 400_000,
        "model_bytes": 32_000,
    }
    assert "secret" not in lines[0]
