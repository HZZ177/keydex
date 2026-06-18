from datetime import UTC, datetime


def utc_now() -> datetime:
    return datetime.now(UTC)


def to_iso_z(value: datetime) -> str:
    normalized = value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)
    return normalized.isoformat().replace("+00:00", "Z")

