from __future__ import annotations

from collections.abc import Awaitable, Callable

from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import (
    ExtendedModelResponse,
    ModelRequest,
    ModelResponse,
)
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage

from backend.app.core.request_context import get_keydex_snapshot
from backend.app.keydex.capabilities.keydex_markdown import (
    KEYDEX_MARKDOWN_CAPABILITY_KEY,
    KEYDEX_MARKDOWN_CONTEXT_PROTOCOL,
    render_keydex_markdown_context,
)
from backend.app.keydex.models import KeydexEffectiveSnapshot


class KeydexMarkdownContextMiddleware(AgentMiddleware):
    """Inject frozen keydex.md guidance into one model request without state writes."""

    @property
    def name(self) -> str:
        return "KeydexMarkdownContextMiddleware"

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[
            [ModelRequest],
            Awaitable[ModelResponse | ExtendedModelResponse | AIMessage],
        ],
    ) -> ModelResponse | ExtendedModelResponse | AIMessage:
        snapshot = get_keydex_snapshot()
        if not isinstance(snapshot, KeydexEffectiveSnapshot):
            return await handler(request)
        effective = snapshot.get(KEYDEX_MARKDOWN_CAPABILITY_KEY)
        if effective is None:
            return await handler(request)
        content = render_keydex_markdown_context(effective)
        if content is None:
            return await handler(request)
        capability = snapshot.capabilities.get(KEYDEX_MARKDOWN_CAPABILITY_KEY.name)
        if capability is None:
            return await handler(request)

        original_messages = list(request.messages or [])
        clean_messages = [
            message
            for message in original_messages
            if not is_keydex_markdown_context_message(message)
        ]
        insertion_index = 0
        while insertion_index < len(clean_messages) and isinstance(
            clean_messages[insertion_index], SystemMessage
        ):
            insertion_index += 1
        injected = HumanMessage(
            content=content,
            additional_kwargs={
                "protocol": KEYDEX_MARKDOWN_CONTEXT_PROTOCOL,
                "effective_fingerprint": capability.fingerprint,
                "scopes": list(effective.scopes),
            },
        )
        model_messages = [
            *clean_messages[:insertion_index],
            injected,
            *clean_messages[insertion_index:],
        ]
        return await handler(request.override(messages=model_messages))


def is_keydex_markdown_context_message(message: BaseMessage) -> bool:
    return (
        isinstance(message, HumanMessage)
        and message.additional_kwargs.get("protocol")
        == KEYDEX_MARKDOWN_CONTEXT_PROTOCOL
    )
