from __future__ import annotations

import re

from .models import GitRefResponse


class GitRefParseError(ValueError):
    pass


REF_FORMAT = (
    "%(refname)%1f%(refname:short)%1f%(objectname)%1f%(objecttype)%1f"
    "%(upstream)%1f%(upstream:track)%1f%(HEAD)%1f%(*objectname)%1f"
    "%(subject)%1f%(creatordate:iso-strict)%00"
)
_TRACK_AHEAD = re.compile(r"ahead (\d+)")
_TRACK_BEHIND = re.compile(r"behind (\d+)")


def parse_for_each_ref(payload: str) -> list[GitRefResponse]:
    refs: list[GitRefResponse] = []
    for raw_record in payload.split("\x00"):
        record = raw_record.strip("\r\n")
        if not record:
            continue
        fields = record.split("\x1f")
        if len(fields) != 10:
            raise GitRefParseError(f"Expected 10 ref fields, received {len(fields)}")
        (
            full_name,
            short_name,
            object_id,
            object_type,
            upstream,
            track,
            head,
            peeled,
            subject,
            created_at,
        ) = fields
        if full_name.startswith("refs/heads/"):
            kind = "local"
            short_name = full_name.removeprefix("refs/heads/")
        elif full_name.startswith("refs/remotes/"):
            kind = "remote"
            short_name = full_name.removeprefix("refs/remotes/")
        elif full_name.startswith("refs/tags/"):
            kind = "tag"
            short_name = full_name.removeprefix("refs/tags/")
        else:
            continue
        ahead_match = _TRACK_AHEAD.search(track)
        behind_match = _TRACK_BEHIND.search(track)
        refs.append(
            GitRefResponse(
                full_name=full_name,
                short_name=short_name,
                kind=kind,
                object_id=object_id,
                peeled_object_id=peeled or None,
                upstream=upstream or None,
                ahead=int(ahead_match.group(1)) if ahead_match else (0 if upstream else None),
                behind=int(behind_match.group(1)) if behind_match else (0 if upstream else None),
                current=head.strip() == "*",
                annotated=kind == "tag" and object_type == "tag",
                annotation=subject if kind == "tag" and object_type == "tag" and subject else None,
                created_at=created_at or None,
            )
        )
    return refs
