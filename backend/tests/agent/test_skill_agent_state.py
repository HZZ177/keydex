from __future__ import annotations

from typing import get_args, get_type_hints

from langgraph.graph.message import add_messages

from backend.app.agent.state import (
    PENDING_SKILL_ACTIVATIONS_RESET_MARKER,
    PENDING_TOOL_CALL_PRESET_STATE_KEY,
    KeydexAgentState,
    build_pending_skill_activations_reset_update,
    build_pending_tool_call_preset_update,
    merge_pending_skill_activations,
)


def test_pending_skill_activations_merge_appends() -> None:
    left = [{"skill_name": "alpha", "content": "A"}]
    right = [{"skill_name": "beta", "content": "B"}]

    result = merge_pending_skill_activations(left, right)

    assert result == [
        {"skill_name": "alpha", "content": "A"},
        {"skill_name": "beta", "content": "B"},
    ]
    assert left == [{"skill_name": "alpha", "content": "A"}]


def test_pending_skill_activations_reset_marker_clears() -> None:
    result = merge_pending_skill_activations(
        [{"skill_name": "alpha", "content": "A"}],
        [PENDING_SKILL_ACTIVATIONS_RESET_MARKER],
    )

    assert result == []


def test_pending_skill_activations_empty_update_keeps_existing() -> None:
    left = [{"skill_name": "alpha", "content": "A"}]

    assert merge_pending_skill_activations(left, []) == left
    assert merge_pending_skill_activations(left, None) == left


def test_pending_skill_activations_reset_update_shape() -> None:
    assert build_pending_skill_activations_reset_update() == {
        "pending_skill_activations": [PENDING_SKILL_ACTIVATIONS_RESET_MARKER],
    }


def test_pending_tool_call_preset_update_and_reset_shape() -> None:
    preset = {"type": "force", "calls": [{"name": "load_skill", "args": {}}]}

    assert build_pending_tool_call_preset_update(preset) == {
        PENDING_TOOL_CALL_PRESET_STATE_KEY: preset,
    }
    assert build_pending_tool_call_preset_update(None) == {
        PENDING_TOOL_CALL_PRESET_STATE_KEY: None,
    }


def test_keydex_agent_state_keeps_messages_reducer() -> None:
    hints = get_type_hints(KeydexAgentState, include_extras=True)

    assert "messages" in hints
    assert PENDING_TOOL_CALL_PRESET_STATE_KEY in hints
    assert "pending_skill_activations" in hints
    assert add_messages in get_args(hints["messages"])
    assert merge_pending_skill_activations in get_args(hints["pending_skill_activations"])
