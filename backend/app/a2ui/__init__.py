"""Built-in A2UI runtime support."""

from backend.app.a2ui.event_payloads import (
    build_a2ui_created_payload,
    build_a2ui_stream_payload,
    build_cancel_ack_payload,
    build_submit_ack_payload,
    build_waiting_input_payload,
)
from backend.app.a2ui.interaction_service import (
    A2UIInteractionMutationResult,
    A2UIInteractionService,
    A2UIInteractionServiceError,
)
from backend.app.a2ui.prompt import build_a2ui_prompt_section
from backend.app.a2ui.registry import (
    A2UIRegistry,
    A2UIToolDefinition,
    BUILTIN_A2UI_RENDER_KEYS,
    build_builtin_a2ui_registry,
)
from backend.app.a2ui.resume_context import (
    A2UIResumeContext,
    build_a2ui_resume_context,
)
from backend.app.a2ui.runtime import (
    A2UIRuntime,
    build_resume_group_id,
    resolve_a2ui_stream_id,
)
from backend.app.a2ui.resume_service import (
    A2UIResumeItem,
    A2UIResumeService,
    A2UIResumeServiceError,
    A2UIResumeSnapshot,
    A2UIResumeStartResult,
)
from backend.app.a2ui.schemas import (
    A2UICancelRequest,
    A2UIObject,
    A2UIResumeSummary,
    A2UISchemaValidationError,
    A2UISubmitRequest,
    interaction_state_from_record,
    validate_payload,
    validate_submit_result,
)
from backend.app.a2ui.stream_bridge import (
    A2UIStreamBridge,
    a2ui_stream_event_type,
    is_a2ui_stream_payload,
    strip_a2ui_stream_marker,
)
from backend.app.a2ui.tools import (
    a2ui_registry_to_langchain_tools,
    a2ui_tool_to_langchain_tool,
    a2ui_tools_to_langchain_tools,
)

__all__ = [
    "A2UICancelRequest",
    "A2UIObject",
    "A2UIRegistry",
    "A2UIInteractionMutationResult",
    "A2UIInteractionService",
    "A2UIInteractionServiceError",
    "A2UIResumeSummary",
    "A2UIResumeItem",
    "A2UIResumeContext",
    "A2UIResumeService",
    "A2UIResumeServiceError",
    "A2UIResumeSnapshot",
    "A2UIResumeStartResult",
    "A2UIRuntime",
    "A2UISchemaValidationError",
    "A2UIStreamBridge",
    "A2UISubmitRequest",
    "A2UIToolDefinition",
    "BUILTIN_A2UI_RENDER_KEYS",
    "build_a2ui_created_payload",
    "build_a2ui_prompt_section",
    "build_a2ui_resume_context",
    "build_a2ui_stream_payload",
    "build_builtin_a2ui_registry",
    "build_resume_group_id",
    "build_cancel_ack_payload",
    "build_submit_ack_payload",
    "build_waiting_input_payload",
    "a2ui_registry_to_langchain_tools",
    "a2ui_stream_event_type",
    "a2ui_tool_to_langchain_tool",
    "a2ui_tools_to_langchain_tools",
    "interaction_state_from_record",
    "resolve_a2ui_stream_id",
    "is_a2ui_stream_payload",
    "strip_a2ui_stream_marker",
    "validate_payload",
    "validate_submit_result",
]
