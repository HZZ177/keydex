from __future__ import annotations

import json
from collections import deque
from dataclasses import fields, is_dataclass
from enum import Enum
from typing import Any

import ormsgpack
import zstandard
from langgraph.checkpoint.serde.base import SerializerProtocol
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer

ZSTD_TYPE_PREFIX = "keydex-zstd-v1:"
DEFAULT_COMPRESSION_MIN_BYTES = 4_096
DEFAULT_MIN_SAVINGS_RATIO = 0.10
DEFAULT_MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024

_CONSTRUCTOR_EXT_CODES = frozenset({0, 1, 2, 4, 5})
_METHOD_EXT_CODE = 3
_NUMPY_EXT_CODE = 6
_DELTA_SNAPSHOT_EXT_CODE = 7
_ALLOWED_METHODS = frozenset({("datetime", "datetime", "fromisoformat")})
_ALLOWED_OBJECT_TYPES = frozenset(
    {
        ("datetime", "datetime"),
        ("datetime", "date"),
        ("datetime", "time"),
        ("datetime", "timedelta"),
        ("datetime", "timezone"),
        ("uuid", "UUID"),
        ("decimal", "Decimal"),
        ("builtins", "set"),
        ("builtins", "frozenset"),
        ("collections", "deque"),
        ("ipaddress", "IPv4Address"),
        ("ipaddress", "IPv4Interface"),
        ("ipaddress", "IPv4Network"),
        ("ipaddress", "IPv6Address"),
        ("ipaddress", "IPv6Interface"),
        ("ipaddress", "IPv6Network"),
        ("pathlib", "Path"),
        ("pathlib", "PosixPath"),
        ("pathlib", "WindowsPath"),
        ("pathlib._local", "Path"),
        ("pathlib._local", "PosixPath"),
        ("pathlib._local", "WindowsPath"),
        ("zoneinfo", "ZoneInfo"),
        ("re", "Pattern"),
        ("langchain_core.messages.base", "BaseMessage"),
        ("langchain_core.messages.base", "BaseMessageChunk"),
        ("langchain_core.messages.human", "HumanMessage"),
        ("langchain_core.messages.human", "HumanMessageChunk"),
        ("langchain_core.messages.ai", "AIMessage"),
        ("langchain_core.messages.ai", "AIMessageChunk"),
        ("langchain_core.messages.system", "SystemMessage"),
        ("langchain_core.messages.system", "SystemMessageChunk"),
        ("langchain_core.messages.chat", "ChatMessage"),
        ("langchain_core.messages.chat", "ChatMessageChunk"),
        ("langchain_core.messages.tool", "ToolMessage"),
        ("langchain_core.messages.tool", "ToolMessageChunk"),
        ("langchain_core.messages.function", "FunctionMessage"),
        ("langchain_core.messages.function", "FunctionMessageChunk"),
        ("langchain_core.messages.modifier", "RemoveMessage"),
        ("langchain_core.documents.base", "Document"),
        ("langgraph.types", "Send"),
        ("langgraph.types", "TimeoutPolicy"),
        ("langgraph.types", "Interrupt"),
        ("langgraph.types", "Command"),
        ("langgraph.types", "StateSnapshot"),
        ("langgraph.types", "PregelTask"),
        ("langgraph.types", "Overwrite"),
        ("langgraph.store.base", "Item"),
        ("langgraph.store.base", "GetOp"),
        ("langgraph.checkpoint.serde.types", "_DeltaSnapshot"),
    }
)
_PRIMITIVE_TYPES = (str, int, float, bool, type(None), bytes, bytearray)


class CheckpointSerializerRejected(ValueError):
    code = "checkpoint_serializer_rejected"

    def __init__(self) -> None:
        super().__init__("checkpoint payload rejected by the strict serializer")


def create_strict_jsonplus_serializer() -> JsonPlusSerializer:
    """Create an explicitly strict inner serializer with no pickle fallback."""
    return JsonPlusSerializer(
        pickle_fallback=False,
        allowed_json_modules=(),
        allowed_msgpack_modules=(),
    )


class KeydexCompressedSerializer(SerializerProtocol):
    """Strict JsonPlus serialization with selective, bounded Zstandard frames."""

    def __init__(
        self,
        *,
        inner: SerializerProtocol | None = None,
        compression_min_bytes: int = DEFAULT_COMPRESSION_MIN_BYTES,
        min_savings_ratio: float = DEFAULT_MIN_SAVINGS_RATIO,
        max_decompressed_bytes: int = DEFAULT_MAX_DECOMPRESSED_BYTES,
        compression_level: int = 3,
    ) -> None:
        if compression_min_bytes < 0:
            raise ValueError("compression_min_bytes must be non-negative")
        if not 0 <= min_savings_ratio < 1:
            raise ValueError("min_savings_ratio must be in [0, 1)")
        if max_decompressed_bytes <= 0:
            raise ValueError("max_decompressed_bytes must be positive")
        self.inner = inner or create_strict_jsonplus_serializer()
        self.compression_min_bytes = compression_min_bytes
        self.min_savings_ratio = min_savings_ratio
        self.max_decompressed_bytes = max_decompressed_bytes
        self._compressor = zstandard.ZstdCompressor(level=compression_level)
        self._decompressor = zstandard.ZstdDecompressor()

    def dumps_typed(self, obj: Any) -> tuple[str, bytes]:
        try:
            _validate_object_graph(obj)
            inner_type, payload = self.inner.dumps_typed(obj)
        except CheckpointSerializerRejected:
            raise
        except Exception as exc:
            raise CheckpointSerializerRejected from exc

        if len(payload) < self.compression_min_bytes:
            return inner_type, payload
        compressed = self._compressor.compress(payload)
        required_max_size = int(len(payload) * (1 - self.min_savings_ratio))
        if len(compressed) > required_max_size:
            return inner_type, payload
        return f"{ZSTD_TYPE_PREFIX}{inner_type}", compressed

    def loads_typed(self, data: tuple[str, bytes]) -> Any:
        type_tag, payload = data
        try:
            inner_type, decoded_payload = self._decode_frame(type_tag, payload)
            _validate_serialized_payload(inner_type, decoded_payload)
            value = self.inner.loads_typed((inner_type, decoded_payload))
            _validate_object_graph(value)
            return value
        except CheckpointSerializerRejected:
            raise
        except Exception as exc:
            raise CheckpointSerializerRejected from exc

    def _decode_frame(self, type_tag: str, payload: bytes) -> tuple[str, bytes]:
        if not type_tag.startswith(ZSTD_TYPE_PREFIX):
            return type_tag, payload
        inner_type = type_tag.removeprefix(ZSTD_TYPE_PREFIX)
        if not inner_type or inner_type.startswith(ZSTD_TYPE_PREFIX):
            raise CheckpointSerializerRejected
        try:
            frame_size = zstandard.frame_content_size(payload)
        except zstandard.ZstdError as exc:
            raise CheckpointSerializerRejected from exc
        if frame_size in {
            zstandard.CONTENTSIZE_ERROR,
            zstandard.CONTENTSIZE_UNKNOWN,
        }:
            raise CheckpointSerializerRejected
        if frame_size > self.max_decompressed_bytes:
            raise CheckpointSerializerRejected
        try:
            decoded = self._decompressor.decompress(
                payload,
                max_output_size=self.max_decompressed_bytes,
                allow_extra_data=False,
            )
        except zstandard.ZstdError as exc:
            raise CheckpointSerializerRejected from exc
        if len(decoded) != frame_size:
            raise CheckpointSerializerRejected
        return inner_type, decoded


def _type_key(value: Any) -> tuple[str, str]:
    value_type = type(value)
    return value_type.__module__, value_type.__name__


def _validate_object_graph(value: Any, seen: set[int] | None = None) -> None:
    if isinstance(value, _PRIMITIVE_TYPES):
        return
    if isinstance(value, Enum):
        _validate_object_graph(value.value, seen)
        return
    seen = seen or set()
    identity = id(value)
    if identity in seen:
        return
    seen.add(identity)

    if type(value) is dict:
        for key, item in value.items():
            _validate_object_graph(key, seen)
            _validate_object_graph(item, seen)
        return
    if type(value) in {list, tuple, set, frozenset, deque}:
        for item in value:
            _validate_object_graph(item, seen)
        return

    if _type_key(value) not in _ALLOWED_OBJECT_TYPES:
        raise CheckpointSerializerRejected
    if hasattr(value, "model_dump") and callable(value.model_dump):
        _validate_object_graph(value.model_dump(mode="python"), seen)
    elif is_dataclass(value) and not isinstance(value, type):
        for field in fields(value):
            _validate_object_graph(getattr(value, field.name), seen)
    elif hasattr(value, "_asdict") and callable(value._asdict):
        _validate_object_graph(value._asdict(), seen)
    elif hasattr(value, "__dict__"):
        _validate_object_graph(vars(value), seen)


def _validate_serialized_payload(type_tag: str, payload: bytes) -> None:
    if type_tag in {"null", "bytes", "bytearray"}:
        return
    if type_tag == "msgpack":
        _validate_msgpack(payload)
        return
    if type_tag == "json":
        try:
            decoded = json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise CheckpointSerializerRejected from exc
        _validate_json_constructors(decoded)
        return
    raise CheckpointSerializerRejected


def _validate_msgpack(payload: bytes) -> None:
    def validate_ext(code: int, data: bytes) -> None:
        if code == _DELTA_SNAPSHOT_EXT_CODE:
            ormsgpack.unpackb(
                data,
                ext_hook=validate_ext,
                option=ormsgpack.OPT_NON_STR_KEYS,
            )
            return None
        if code == _METHOD_EXT_CODE:
            decoded = ormsgpack.unpackb(
                data,
                ext_hook=validate_ext,
                option=ormsgpack.OPT_NON_STR_KEYS,
            )
            if (
                not isinstance(decoded, list | tuple)
                or len(decoded) < 4
                or tuple(decoded[:2]) + (decoded[3],) not in _ALLOWED_METHODS
            ):
                raise CheckpointSerializerRejected
            return None
        if code in _CONSTRUCTOR_EXT_CODES:
            decoded = ormsgpack.unpackb(
                data,
                ext_hook=validate_ext,
                option=ormsgpack.OPT_NON_STR_KEYS,
            )
            if (
                not isinstance(decoded, list | tuple)
                or len(decoded) < 2
                or tuple(decoded[:2]) not in _ALLOWED_OBJECT_TYPES
            ):
                raise CheckpointSerializerRejected
            return None
        if code == _NUMPY_EXT_CODE:
            raise CheckpointSerializerRejected
        raise CheckpointSerializerRejected

    try:
        ormsgpack.unpackb(
            payload,
            ext_hook=validate_ext,
            option=ormsgpack.OPT_NON_STR_KEYS,
        )
    except CheckpointSerializerRejected:
        raise
    except Exception as exc:
        raise CheckpointSerializerRejected from exc


def _validate_json_constructors(value: Any) -> None:
    if isinstance(value, list):
        for item in value:
            _validate_json_constructors(item)
        return
    if not isinstance(value, dict):
        return
    if value.get("lc") == 2 and value.get("type") == "constructor":
        identifier = value.get("id")
        if not isinstance(identifier, list) or len(identifier) < 2:
            raise CheckpointSerializerRejected
        key = (".".join(str(part) for part in identifier[:-1]), str(identifier[-1]))
        if key not in _ALLOWED_OBJECT_TYPES:
            raise CheckpointSerializerRejected
    for item in value.values():
        _validate_json_constructors(item)
