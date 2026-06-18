from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = ROOT / ".dev" / "verification" / "backend-replication-contract-CDXKAF-00A.md"


def _contract_text() -> str:
    return CONTRACT.read_text(encoding="utf-8")


def test_replication_contract_declares_core_scope_and_cut_list() -> None:
    text = _contract_text()

    required_phrases = [
        "核心运行合同必须强一致",
        "不是全量搬运源项目所有平台接口",
        "非桌面目标能力必须显式登记为裁剪项",
        "不实现且不暴露入口",
        "scheduled_chat",
        "/ws/debug",
        "/ws/event",
    ]

    for phrase in required_phrases:
        assert phrase in text


def test_replication_contract_pins_source_files_and_corrected_message_event_path() -> None:
    text = _contract_text()

    required_paths = [
        "agent_backend/api/ws_router.py",
        "agent_backend/services/ws_handler_service.py",
        "agent_backend/services/chat_service.py",
        "agent_backend/engine/event_handler.py",
        "agent_backend/events/chat_projection.py",
        "agent_backend/events/persistence_projection.py",
        "agent_backend/events/completed_aggregator.py",
        "agent_backend/services/message_event_service.py",
        "common/common_service/session_service.py",
    ]

    for path in required_paths:
        assert path in text

    assert "路径修正登记" in text
    assert "common/common_service/message_event_service.py" in text


def test_replication_contract_covers_required_protocol_actions_and_event_mappings() -> None:
    text = _contract_text()

    inbound_actions = [
        "create_session",
        "bind_session",
        "unbind_session",
        "chat",
        "cancel",
        "ping",
        "get_status",
        "close_session",
    ]
    chat_actions = [
        "stream",
        "tool_start",
        "tool_end",
        "subagent_start",
        "subagent_end",
        "subagent_error",
        "reasoning",
        "completed",
        "cancelled",
        "error",
    ]
    replay_actions = [
        "user_message",
        "system_message",
        "ai_message",
        "stream_batch",
        "memory_recalled",
    ]
    domain_events = [
        "message.user.created",
        "llm.stream",
        "llm.tool.started",
        "llm.tool.finished",
        "llm.tool.failed",
        "turn.started",
        "turn.completed",
        "turn.cancelled",
        "turn.failed",
        "reasoning.stream",
        "reasoning.finished",
    ]

    for value in inbound_actions + chat_actions + replay_actions + domain_events:
        assert value in text


def test_replication_contract_rejects_old_thread_turn_item_runtime_as_replacement() -> None:
    text = _contract_text()

    assert "/api/threads" in text
    assert "/api/threads/{id}/turns" in text
    assert "Thread/Turn/Item/RuntimeEvent" in text
    assert "不能使用旧" in text
