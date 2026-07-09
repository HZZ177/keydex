from __future__ import annotations

import asyncio
from typing import Any


def is_stream_chunk_timeout_error(error: BaseException) -> bool:
    """Return True for langchain-openai per-stream-chunk timeout errors."""
    if not isinstance(error, (asyncio.TimeoutError, TimeoutError)):
        return False
    cls = type(error)
    if cls.__name__ != "StreamChunkTimeoutError":
        return False
    module = str(getattr(cls, "__module__", "") or "")
    if module and not module.startswith("langchain_openai."):
        return False
    return hasattr(error, "timeout_s") and hasattr(error, "chunks_received")


def stream_chunk_timeout_details(error: BaseException) -> dict[str, Any]:
    details: dict[str, Any] = {}
    timeout_s = getattr(error, "timeout_s", None)
    chunks_received = getattr(error, "chunks_received", None)
    model_name = getattr(error, "model_name", None)
    if isinstance(timeout_s, (int, float)) and not isinstance(timeout_s, bool):
        details["timeout_seconds"] = float(timeout_s)
    if isinstance(chunks_received, int) and not isinstance(chunks_received, bool):
        details["chunks_received"] = chunks_received
    if isinstance(model_name, str) and model_name.strip():
        details["model"] = model_name.strip()
    return details
