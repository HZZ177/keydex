from __future__ import annotations

from .models import GitStashEntryResponse

STASH_FORMAT = "%gd%x00%H%x00%P%x00%an%x00%aI%x00%s%x00"


class GitStashParseError(ValueError):
    pass


def parse_stash_list(payload: str) -> list[GitStashEntryResponse]:
    fields = payload.split("\x00")
    while fields and not fields[-1].strip("\r\n"):
        fields.pop()
    if len(fields) % 6:
        raise GitStashParseError("Stash output has an incomplete record")
    entries: list[GitStashEntryResponse] = []
    for offset in range(0, len(fields), 6):
        selector, object_id, parents, author_name, created_at, message = fields[offset : offset + 6]
        parent_ids = parents.split()
        entries.append(
            GitStashEntryResponse(
                selector=selector.lstrip("\r\n"),
                object_id=object_id,
                base_object_id=parent_ids[0] if parent_ids else None,
                author_name=author_name,
                created_at=created_at,
                message=message.rstrip("\r\n"),
            )
        )
    return entries
