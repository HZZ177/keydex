from __future__ import annotations

from typing import Any

INTERNAL_CONTEXT_COMPRESSION_TAG = "keydex_internal_context_compression"
INTERNAL_CONTEXT_COMPRESSION_METADATA_KEY = "keydex_internal_context_compression"


def context_compression_llm_config() -> dict[str, Any]:
    return {
        "tags": [INTERNAL_CONTEXT_COMPRESSION_TAG],
        "metadata": {INTERNAL_CONTEXT_COMPRESSION_METADATA_KEY: True},
        "run_name": "keydex_context_compression",
    }


def is_internal_context_compression_event(event: dict[str, Any]) -> bool:
    tags = event.get("tags")
    if isinstance(tags, list) and INTERNAL_CONTEXT_COMPRESSION_TAG in tags:
        return True
    metadata = event.get("metadata")
    if isinstance(metadata, dict) and metadata.get(INTERNAL_CONTEXT_COMPRESSION_METADATA_KEY) is True:
        return True
    data = event.get("data")
    if isinstance(data, dict):
        data_metadata = data.get("metadata")
        if (
            isinstance(data_metadata, dict)
            and data_metadata.get(INTERNAL_CONTEXT_COMPRESSION_METADATA_KEY) is True
        ):
            return True
    return str(event.get("name") or "") == "keydex_context_compression"
