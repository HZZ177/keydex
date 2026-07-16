from __future__ import annotations

from .models import GitCommitResponse


class GitHistoryParseError(ValueError):
    pass


LOG_FORMAT = (
    "%x1e%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00"
    "%s%x00%b%x00%D%x00%G?%x00"
)
_SIGNATURE = {
    "G": "valid",
    "B": "invalid",
    "U": "unknown",
    "X": "unknown",
    "Y": "unknown",
    "R": "unknown",
    "E": "unknown",
    "N": "unsigned",
    "": "unsigned",
}


def parse_git_log(payload: str) -> list[GitCommitResponse]:
    commits: list[GitCommitResponse] = []
    for raw_record in payload.split("\x1e"):
        record = raw_record.strip("\r\n")
        if not record:
            continue
        fields = record.split("\x00")
        while fields and fields[-1] == "":
            fields.pop()
        if len(fields) != 12:
            raise GitHistoryParseError(f"Expected 12 commit fields, received {len(fields)}")
        (
            object_id,
            parents,
            author_name,
            author_email,
            authored_at,
            committer_name,
            committer_email,
            committed_at,
            subject,
            body,
            decorations,
            signature,
        ) = fields
        commits.append(
            GitCommitResponse(
                object_id=object_id,
                parent_ids=parents.split() if parents else [],
                author_name=author_name,
                author_email=author_email,
                authored_at=authored_at,
                committer_name=committer_name,
                committer_email=committer_email,
                committed_at=committed_at,
                subject=subject,
                body=body.rstrip("\n"),
                decorations=[item.strip() for item in decorations.split(",") if item.strip()],
                signature=_SIGNATURE.get(signature, "unknown"),
            )
        )
    return commits
