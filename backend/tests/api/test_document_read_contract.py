from __future__ import annotations

import pytest
from pydantic import TypeAdapter, ValidationError

from backend.app.api.document_read import (
    DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES,
    DOCUMENT_READ_PROTOCOL_VERSION,
    DocumentReadChunkMessage,
    DocumentReadMessage,
    DocumentReadRequest,
    DocumentReadSource,
    DocumentReadStartMessage,
    create_document_read_messages,
    split_utf8_chunks,
)
from backend.app.tools.filesystem import MAX_READ_BYTES as AGENT_READ_FILE_MAX_BYTES


def _request(**overrides: object) -> DocumentReadRequest:
    values = {
        "request_id": "request-1",
        "document_id": "workspace:fixture.md",
        "source": DocumentReadSource.WORKSPACE,
        "path": "fixture.md",
    }
    values.update(overrides)
    return DocumentReadRequest(**values)


@pytest.mark.parametrize("size", [512 * 1024 - 1, 512 * 1024, 512 * 1024 + 1, 10 * 1024 * 1024])
def test_document_read_messages_support_preview_boundaries(size: int) -> None:
    data = b"x" * size
    messages = create_document_read_messages(
        request=_request(),
        revision=f"revision-{size}",
        data=data,
    )

    assert isinstance(messages[0], DocumentReadStartMessage)
    assert messages[0].total_bytes == size
    assert messages[-1].type == "complete"
    chunks = [message for message in messages if isinstance(message, DocumentReadChunkMessage)]
    assert sum(chunk.byte_length for chunk in chunks) == size


def test_utf8_chunks_never_split_code_points() -> None:
    data = "甲乙丙丁👩🏽‍💻tail".encode()
    chunks = split_utf8_chunks(data, 5)

    assert b"".join(content.encode() for _, content in chunks) == data
    assert [offset for offset, _ in chunks] == [
        sum(len(content.encode()) for _, content in chunks[:index])
        for index in range(len(chunks))
    ]


def test_document_read_union_rejects_unknown_message() -> None:
    adapter = TypeAdapter(DocumentReadMessage)
    with pytest.raises(ValidationError):
        adapter.validate_python({
            "protocol_version": DOCUMENT_READ_PROTOCOL_VERSION,
            "type": "unknown",
            "request_id": "request-1",
            "document_id": "document-1",
        })


def test_non_utf8_bytes_are_rejected() -> None:
    with pytest.raises(UnicodeDecodeError):
        create_document_read_messages(request=_request(), revision="r1", data=b"\xff\xfe")


def test_preview_limit_does_not_change_agent_read_file_limit() -> None:
    assert DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES == 20 * 1024 * 1024
    assert AGENT_READ_FILE_MAX_BYTES == 512 * 1024
