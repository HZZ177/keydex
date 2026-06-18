from enum import StrEnum
from uuid import uuid4


class IdPrefix(StrEnum):
    SESSION = "ses"
    THREAD = "thr"
    TURN = "turn"
    ITEM = "item"
    CALL = "call"
    APPROVAL = "appr"
    EVENT = "evt"
    SUBMISSION = "sub"


def new_id(prefix: IdPrefix | str) -> str:
    value = prefix.value if isinstance(prefix, IdPrefix) else str(prefix)
    normalized = value.strip("_")
    if not normalized:
        raise ValueError("ID 前缀不能为空")
    return f"{normalized}_{uuid4().hex}"


def validate_prefixed_id(value: str, prefix: IdPrefix | str) -> str:
    expected = prefix.value if isinstance(prefix, IdPrefix) else str(prefix)
    if not value.startswith(f"{expected}_"):
        raise ValueError(f"ID 必须以 {expected}_ 开头")
    return value
