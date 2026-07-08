from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from backend.app.a2ui.event_payloads import (
    build_cancel_ack_payload,
    build_submit_ack_payload,
)
from backend.app.a2ui.schemas import (
    A2UICancelRequest,
    A2UIInteractionState,
    A2UIResumeSummary,
    A2UISchemaValidationError,
    A2UISubmitRequest,
    interaction_state_from_record,
    validate_submit_result,
)
from backend.app.events.dispatcher import EventDispatcher
from backend.app.events.event_types import DomainEventType
from backend.app.storage import (
    A2UI_STATUS_CANCELLED,
    A2UI_STATUS_SUBMITTED,
    A2UI_STATUS_WAITING_USER_INPUT,
    A2UIInteractionRecord,
    StorageRepositories,
)


class A2UIInteractionServiceError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    def to_payload(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message}


@dataclass(frozen=True)
class A2UIInteractionMutationResult:
    interaction: A2UIInteractionRecord
    ack_payload: dict[str, Any]
    resume_payload: dict[str, Any] | None
    should_resume: bool
    idempotent: bool = False


class A2UIInteractionService:
    def __init__(
        self,
        *,
        repositories: StorageRepositories,
        dispatcher: EventDispatcher,
    ) -> None:
        self.repositories = repositories
        self.dispatcher = dispatcher

    async def submit(
        self,
        request: A2UISubmitRequest | dict[str, Any],
    ) -> A2UIInteractionMutationResult:
        parsed = _coerce_submit_request(request)
        current = self._require_interaction(parsed.interaction_id)
        self._ensure_session(current, parsed.session_id)

        if current.status == A2UI_STATUS_SUBMITTED:
            if current.submit_request_id == parsed.request_id:
                return self._build_submit_result(
                    interaction=current,
                    request=parsed,
                    resume_payload=current.resume_payload,
                    idempotent=True,
                    should_resume=False,
                )
            raise A2UIInteractionServiceError(
                "interaction_already_submitted",
                f"A2UI interaction already submitted: {current.id}",
            )
        if current.status == A2UI_STATUS_CANCELLED:
            raise A2UIInteractionServiceError(
                "interaction_already_cancelled",
                f"A2UI interaction already cancelled: {current.id}",
            )
        if current.status != A2UI_STATUS_WAITING_USER_INPUT:
            raise A2UIInteractionServiceError(
                "interaction_not_waiting",
                f"A2UI interaction status does not allow submit: {current.status}",
            )

        try:
            submit_result = validate_submit_result(
                parsed.submit_result,
                current.submit_schema_snapshot,
            )
        except A2UISchemaValidationError as exc:
            raise A2UIInteractionServiceError(
                "schema_validation_failed",
                str(exc),
            ) from exc

        resume_payload = _build_submit_resume_payload(current, submit_result)
        updated = self.repositories.a2ui_interactions.submit(
            current.id,
            request_id=parsed.request_id,
            submit_result=submit_result,
            resume_payload=resume_payload,
        )
        result = self._build_submit_result(
            interaction=updated,
            request=parsed,
            resume_payload=resume_payload,
            should_resume=True,
        )
        await self._emit_mutation_event(
            event_type=DomainEventType.A2UI_SUBMITTED,
            source="a2ui_submit",
            interaction=updated,
            payload=result.ack_payload,
        )
        return result

    async def cancel(
        self,
        request: A2UICancelRequest | dict[str, Any],
    ) -> A2UIInteractionMutationResult:
        parsed = _coerce_cancel_request(request)
        current = self._require_interaction(parsed.interaction_id)
        self._ensure_session(current, parsed.session_id)

        if current.status == A2UI_STATUS_CANCELLED:
            if current.cancel_request_id == parsed.request_id:
                return self._build_cancel_result(
                    interaction=current,
                    request=parsed,
                    resume_payload=current.resume_payload,
                    idempotent=True,
                    should_resume=False,
                )
            raise A2UIInteractionServiceError(
                "interaction_already_cancelled",
                f"A2UI interaction already cancelled: {current.id}",
            )
        if current.status == A2UI_STATUS_SUBMITTED:
            raise A2UIInteractionServiceError(
                "interaction_already_submitted",
                f"A2UI interaction already submitted: {current.id}",
            )
        if current.status != A2UI_STATUS_WAITING_USER_INPUT:
            raise A2UIInteractionServiceError(
                "interaction_not_waiting",
                f"A2UI interaction status does not allow cancel: {current.status}",
            )

        reason = parsed.cancel_reason or ""
        resume_payload = {
            "status": A2UI_STATUS_CANCELLED,
            "interaction_id": current.id,
            "reason": reason,
        }
        updated = self.repositories.a2ui_interactions.cancel(
            current.id,
            request_id=parsed.request_id,
            cancel_reason=reason,
            resume_payload=resume_payload,
        )
        result = self._build_cancel_result(
            interaction=updated,
            request=parsed,
            resume_payload=resume_payload,
            should_resume=True,
        )
        await self._emit_mutation_event(
            event_type=DomainEventType.A2UI_CANCELLED,
            source="a2ui_cancel",
            interaction=updated,
            payload=result.ack_payload,
        )
        return result

    def _require_interaction(self, interaction_id: str) -> A2UIInteractionRecord:
        interaction = self.repositories.a2ui_interactions.get(interaction_id)
        if interaction is None:
            raise A2UIInteractionServiceError(
                "interaction_not_found",
                f"A2UI interaction not found: {interaction_id}",
            )
        return interaction

    @staticmethod
    def _ensure_session(
        interaction: A2UIInteractionRecord,
        request_session_id: str | None,
    ) -> None:
        if request_session_id is not None and request_session_id != interaction.session_id:
            raise A2UIInteractionServiceError(
                "session_mismatch",
                "A2UI interaction does not belong to the requested session",
            )

    def _build_submit_result(
        self,
        *,
        interaction: A2UIInteractionRecord,
        request: A2UISubmitRequest,
        resume_payload: dict[str, Any] | None,
        should_resume: bool,
        idempotent: bool = False,
    ) -> A2UIInteractionMutationResult:
        resume = _resume_summary(interaction)
        interaction_state = interaction_state_from_record(interaction)
        submit_result = interaction.submit_result or request.submit_result
        ack_payload = build_submit_ack_payload(
            interaction_id=interaction.id,
            request_id=request.request_id,
            status=interaction.status,
            submit_result=submit_result,
            resume=resume,
        )
        _enrich_ack_payload(
            ack_payload,
            interaction=interaction,
            interaction_state=interaction_state,
            idempotent=idempotent,
        )
        return A2UIInteractionMutationResult(
            interaction=interaction,
            ack_payload=ack_payload,
            resume_payload=resume_payload,
            should_resume=should_resume,
            idempotent=idempotent,
        )

    def _build_cancel_result(
        self,
        *,
        interaction: A2UIInteractionRecord,
        request: A2UICancelRequest,
        resume_payload: dict[str, Any] | None,
        should_resume: bool,
        idempotent: bool = False,
    ) -> A2UIInteractionMutationResult:
        resume = _resume_summary(interaction)
        interaction_state = interaction_state_from_record(interaction)
        ack_payload = build_cancel_ack_payload(
            interaction_id=interaction.id,
            request_id=request.request_id,
            status=interaction.status,
            cancel_reason=interaction.cancel_reason or request.cancel_reason,
            resume=resume,
        )
        _enrich_ack_payload(
            ack_payload,
            interaction=interaction,
            interaction_state=interaction_state,
            idempotent=idempotent,
        )
        return A2UIInteractionMutationResult(
            interaction=interaction,
            ack_payload=ack_payload,
            resume_payload=resume_payload,
            should_resume=should_resume,
            idempotent=idempotent,
        )

    async def _emit_mutation_event(
        self,
        *,
        event_type: DomainEventType,
        source: str,
        interaction: A2UIInteractionRecord,
        payload: dict[str, Any],
    ) -> None:
        await self.dispatcher.emit_event(
            event_type=event_type.value,
            source=source,
            payload=payload,
            original_session_id=interaction.session_id,
            active_session_id=interaction.active_session_id or interaction.session_id,
            trace_id=interaction.trace_id,
            turn_index=interaction.turn_index,
        )


def _coerce_submit_request(request: A2UISubmitRequest | dict[str, Any]) -> A2UISubmitRequest:
    if isinstance(request, A2UISubmitRequest):
        return request
    try:
        return A2UISubmitRequest.model_validate(request)
    except ValidationError as exc:
        raise A2UIInteractionServiceError("invalid_request", str(exc)) from exc


def _coerce_cancel_request(request: A2UICancelRequest | dict[str, Any]) -> A2UICancelRequest:
    if isinstance(request, A2UICancelRequest):
        return request
    try:
        return A2UICancelRequest.model_validate(request)
    except ValidationError as exc:
        raise A2UIInteractionServiceError("invalid_request", str(exc)) from exc


def _resume_summary(interaction: A2UIInteractionRecord) -> A2UIResumeSummary:
    return A2UIResumeSummary(
        status=interaction.resume_status,
        resume_group_id=interaction.resume_group_id,
        pending_count=0,
        error=interaction.resume_error,
    )


def _build_submit_resume_payload(
    interaction: A2UIInteractionRecord,
    submit_result: dict[str, Any],
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "status": A2UI_STATUS_SUBMITTED,
        "interaction_id": interaction.id,
        "submit_result": submit_result,
    }
    if interaction.render_key == "choice":
        agent_instruction = _choice_agent_instruction(interaction.payload, submit_result)
        if agent_instruction:
            payload["agent_instruction"] = agent_instruction
    return payload


def _choice_agent_instruction(
    choice_payload: dict[str, Any] | None,
    submit_result: dict[str, Any],
) -> str:
    selected_values = _string_list(submit_result.get("selected_values"))
    correction_note = _scalar_text(
        submit_result.get("correction_note")
        or submit_result.get("note")
        or submit_result.get("comment")
    )
    result_type = _scalar_text(submit_result.get("result_type")).lower()
    if result_type == "correction" or (correction_note and not selected_values):
        return (
            "用户选择了“以上都不对”，并补充意见："
            f"{correction_note}。请根据该意见重新调整后续回复或重新生成候选项，不要继续按原候选项执行。"
        )

    if not selected_values:
        return "用户没有选择任何候选项。"

    labels = _choice_labels_for_values(choice_payload or {}, selected_values)
    selected_text = "、".join(labels or selected_values)
    return f"用户已选择：{selected_text}。请按用户选择继续。"


def _choice_labels_for_values(
    choice_payload: dict[str, Any],
    selected_values: list[str],
) -> list[str]:
    options = choice_payload.get("options")
    if not isinstance(options, list):
        return []
    label_by_value: dict[str, str] = {}
    for option in options:
        if not isinstance(option, dict):
            continue
        value = _scalar_text(option.get("value"))
        label = _scalar_text(option.get("label"))
        if value:
            label_by_value[value] = label or value
    return [label_by_value.get(value, value) for value in selected_values]


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in (_scalar_text(item) for item in value) if item]


def _scalar_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value)
    return ""


def _enrich_ack_payload(
    payload: dict[str, Any],
    *,
    interaction: A2UIInteractionRecord,
    interaction_state: A2UIInteractionState,
    idempotent: bool,
) -> None:
    payload["session_id"] = interaction.session_id
    payload["trace_id"] = interaction.trace_id
    payload["turn_index"] = interaction.turn_index
    payload["render_key"] = interaction.render_key
    payload["stream_id"] = interaction.stream_id
    payload["tool_call_id"] = interaction.tool_call_id
    payload["can_submit"] = interaction.can_submit
    payload["idempotent"] = idempotent
    payload["interaction"] = interaction_state.model_dump(mode="json")
