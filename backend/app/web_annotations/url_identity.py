from __future__ import annotations

import hashlib
import ipaddress
import re
from dataclasses import dataclass
from typing import Literal
from urllib.parse import quote, unquote, unquote_plus, urlsplit, urlunsplit

WEB_ANNOTATION_URL_NORMALIZATION_VERSION = 1
LOCAL_FILE_ANNOTATION_URL_NORMALIZATION_VERSION = 2
MAX_WEB_ANNOTATION_URL_BYTES = 8 * 1024
REDACTED_QUERY_VALUE = "__keydex_redacted__"

_INVALID_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")
_PERCENT_ESCAPE = re.compile(r"%([0-9A-Fa-f]{2})")
_SENSITIVE_PARAMETER_PARTS = frozenset(
    {
        "auth",
        "authorization",
        "code",
        "credential",
        "jwt",
        "key",
        "nonce",
        "password",
        "passwd",
        "pwd",
        "secret",
        "session",
        "sessionid",
        "sig",
        "signature",
        "state",
        "token",
    }
)
_EMBEDDED_SENSITIVE_PARAMETER = re.compile(
    r"(?:^|[?&#;])(?:[^=&#;]*[_\-.])?"
    r"(?:auth(?:orization)?|code|credential|jwt|key|nonce|passw(?:or)?d|pwd|secret|"
    r"session(?:_?id)?|sig(?:nature)?|state|token)\s*=",
    re.IGNORECASE,
)


class WebUrlIdentityError(ValueError):
    """Raised when a page URL cannot be safely normalized for persistence."""

    code = "web_annotation_invalid_url"


@dataclass(frozen=True, slots=True)
class WebUrlIdentity:
    source_kind: Literal["web", "local_file"]
    normalization_version: int
    url_key: str
    url_normalized: str
    document_url: str
    origin: str


def normalize_web_url(value: str) -> WebUrlIdentity:
    """Return the authoritative, redacted identity for an HTTP(S) page URL."""

    raw = _validate_raw_url(value)
    try:
        parsed = urlsplit(raw)
    except ValueError as exc:
        raise WebUrlIdentityError("URL cannot be parsed") from exc

    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise WebUrlIdentityError("Only http and https URLs are supported")
    if parsed.username is not None or parsed.password is not None:
        raise WebUrlIdentityError("URL user information cannot be persisted")
    if parsed.hostname is None:
        raise WebUrlIdentityError("URL must include a host")

    host = _normalize_host(parsed.hostname)
    try:
        port = parsed.port
    except ValueError as exc:
        raise WebUrlIdentityError("URL port is invalid") from exc
    if port == (80 if scheme == "http" else 443):
        port = None

    authority_host = f"[{host}]" if ":" in host else host
    authority = authority_host if port is None else f"{authority_host}:{port}"
    origin = f"{scheme}://{authority}"
    path = _normalize_path(parsed.path or "/")
    query = _redact_parameter_string(parsed.query)
    fragment = _redact_fragment(parsed.fragment)
    url_normalized = urlunsplit((scheme, authority, path, query, fragment))
    document_url = urlunsplit((scheme, authority, path, query, ""))
    digest_input = (f"{WEB_ANNOTATION_URL_NORMALIZATION_VERSION}\n{url_normalized}").encode()
    return WebUrlIdentity(
        source_kind="web",
        normalization_version=WEB_ANNOTATION_URL_NORMALIZATION_VERSION,
        url_key=hashlib.sha256(digest_input).hexdigest(),
        url_normalized=url_normalized,
        document_url=document_url,
        origin=origin,
    )


def normalize_local_file_url(value: str) -> WebUrlIdentity:
    """Return a version-2, Windows-stable identity for a local file page.

    The identity is purely lexical: it never stats or opens the referenced
    file. Drive and UNC paths are case-insensitive for the digest while the
    normalized URL retains display casing. A URL fragment identifies a page
    state and participates in ``url_key``; ``document_url`` excludes it.
    """

    raw = _validate_local_file_input(value)
    if re.match(r"^[A-Za-z]:[\\/]", raw):
        authority, path_segments, fragment = _local_identity_from_drive_path(raw)
    elif raw.startswith(("\\\\", "//")) and not raw.lower().startswith("file://"):
        authority, path_segments, fragment = _local_identity_from_unc_path(raw)
    else:
        authority, path_segments, fragment = _local_identity_from_file_url(raw)

    if authority is None:
        drive = path_segments[0]
        encoded_tail = "/".join(_encode_local_file_segment(item) for item in path_segments[1:])
        document_url = f"file:///{drive}/{encoded_tail}"
        origin = "file://"
    else:
        encoded_path = "/".join(_encode_local_file_segment(item) for item in path_segments)
        document_url = f"file://{authority}/{encoded_path}"
        origin = f"file://{authority}"
    normalized_fragment = _redact_fragment(fragment)
    url_normalized = (
        f"{document_url}#{normalized_fragment}"
        if normalized_fragment
        else document_url
    )
    digest_input = (
        f"{LOCAL_FILE_ANNOTATION_URL_NORMALIZATION_VERSION}\n"
        f"{url_normalized.casefold()}"
    ).encode()
    return WebUrlIdentity(
        source_kind="local_file",
        normalization_version=LOCAL_FILE_ANNOTATION_URL_NORMALIZATION_VERSION,
        url_key=hashlib.sha256(digest_input).hexdigest(),
        url_normalized=url_normalized,
        document_url=document_url,
        origin=origin,
    )


def normalize_annotation_url(
    value: str,
    *,
    source_kind: Literal["web", "local_file"] = "web",
) -> WebUrlIdentity:
    if source_kind == "local_file":
        return normalize_local_file_url(value)
    return normalize_web_url(value)


def _validate_local_file_input(value: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise WebUrlIdentityError("Local file URL must be a non-empty trimmed string")
    if len(value.encode("utf-8")) > MAX_WEB_ANNOTATION_URL_BYTES:
        raise WebUrlIdentityError(
            f"Local file URL cannot exceed {MAX_WEB_ANNOTATION_URL_BYTES} bytes"
        )
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        raise WebUrlIdentityError("Local file URL cannot contain control characters")
    return value


def _local_identity_from_drive_path(
    value: str,
) -> tuple[None, list[str], str]:
    if value.endswith(("\\", "/")):
        raise WebUrlIdentityError("Local directories are not page identities")
    drive = value[0].upper() + ":"
    segments = _normalize_local_file_segments(re.split(r"[\\/]", value[3:]))
    if not segments:
        raise WebUrlIdentityError("Local file path must include a file name")
    return None, [drive, *segments], ""


def _local_identity_from_unc_path(
    value: str,
) -> tuple[str, list[str], str]:
    if value.endswith(("\\", "/")):
        raise WebUrlIdentityError("Local directories are not page identities")
    parts = re.split(r"[\\/]", value[2:])
    authority = parts.pop(0).casefold() if parts else ""
    segments = _normalize_local_file_segments(parts)
    if not _is_valid_file_authority(authority) or len(segments) < 2:
        raise WebUrlIdentityError("UNC file identity requires a host, share, and file")
    return authority, segments, ""


def _local_identity_from_file_url(
    value: str,
) -> tuple[str | None, list[str], str]:
    if not value.lower().startswith("file:") or _INVALID_PERCENT_ESCAPE.search(value):
        raise WebUrlIdentityError("Local file identity must use a valid file URL")
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise WebUrlIdentityError("Local file URL cannot be parsed") from exc
    if (
        parsed.scheme.casefold() != "file"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
    ):
        raise WebUrlIdentityError("Local file URL authority or query is invalid")
    try:
        decoded = [unquote(item, errors="strict") for item in parsed.path.split("/") if item]
    except UnicodeDecodeError as exc:
        raise WebUrlIdentityError("Local file URL path is not valid UTF-8") from exc
    if not decoded or parsed.path.endswith("/"):
        raise WebUrlIdentityError("Local file path must include a file name")
    authority = (parsed.hostname or "").casefold()
    if not authority or authority == "localhost":
        drive = decoded[0]
        if re.fullmatch(r"[A-Za-z]:", drive) is None:
            raise WebUrlIdentityError("Local file URL requires a Windows drive")
        segments = _normalize_local_file_segments(decoded[1:])
        if not segments:
            raise WebUrlIdentityError("Local file path must include a file name")
        return None, [drive[0].upper() + ":", *segments], parsed.fragment
    if not _is_valid_file_authority(authority):
        raise WebUrlIdentityError("Local file URL authority is invalid")
    segments = _normalize_local_file_segments(decoded)
    if len(segments) < 2:
        raise WebUrlIdentityError("UNC file identity requires a share and file")
    return authority, segments, parsed.fragment


def _normalize_local_file_segments(values: list[str]) -> list[str]:
    normalized: list[str] = []
    for value in values:
        if not value or value == ".":
            continue
        if value == "..":
            if not normalized:
                raise WebUrlIdentityError("Local file path cannot escape its root")
            normalized.pop()
            continue
        if any(
            character in '<>:"|?*/\\' or ord(character) < 0x20
            for character in value
        ):
            raise WebUrlIdentityError("Local file path contains invalid characters")
        normalized.append(value)
    return normalized


def _encode_local_file_segment(value: str) -> str:
    return quote(value, safe="!$&'()+,;=@-._~", encoding="utf-8", errors="strict")


def _is_valid_file_authority(value: str) -> bool:
    return bool(
        value
        and len(value) <= 253
        and all(
            label
            and len(label) <= 63
            and not label.startswith("-")
            and not label.endswith("-")
            and re.fullmatch(r"[a-z0-9-]+", label) is not None
            for label in value.split(".")
        )
    )


def normalize_page_reference_url(
    value: str,
    *,
    allow_about_blank: bool = False,
    source_kind: Literal["web", "local_file"] | None = "web",
) -> str:
    """Normalize a persisted frame/canonical URL without creating identity aliases."""

    if allow_about_blank and value == "about:blank":
        return value
    if source_kind is None:
        source_kind = _absolute_reference_source_kind(value)
    return normalize_annotation_url(value, source_kind=source_kind).url_normalized


def sanitize_url_reference(
    value: str,
    *,
    source_kind: Literal["web", "local_file"] | None = None,
) -> str:
    """Sanitize a stable href/src attribute while preserving relative URL semantics."""

    raw = _validate_raw_url(value, max_bytes=4 * 1024)
    try:
        parsed = urlsplit(raw)
    except ValueError as exc:
        raise WebUrlIdentityError("URL reference cannot be parsed") from exc
    if parsed.scheme:
        reference_kind = _absolute_reference_source_kind(raw)
        if source_kind is not None and reference_kind != source_kind:
            raise WebUrlIdentityError("Stable URL attribute scheme does not match page source")
        return normalize_annotation_url(raw, source_kind=reference_kind).url_normalized
    if parsed.netloc:
        raise WebUrlIdentityError("Protocol-relative stable URL attributes are unsupported")
    path = _normalize_percent_encoding(parsed.path, safe="/:@!$&'()*+,;=-._~%")
    query = _redact_parameter_string(parsed.query)
    fragment = _redact_fragment(parsed.fragment)
    return urlunsplit(("", "", path, query, fragment))


def _absolute_reference_source_kind(
    value: str,
) -> Literal["web", "local_file"]:
    try:
        scheme = urlsplit(value).scheme.casefold()
    except ValueError as exc:
        raise WebUrlIdentityError("URL reference cannot be parsed") from exc
    if scheme in {"http", "https"}:
        return "web"
    if scheme == "file":
        return "local_file"
    raise WebUrlIdentityError("Page URL reference must use http, https, or file")


def _validate_raw_url(value: str, *, max_bytes: int = MAX_WEB_ANNOTATION_URL_BYTES) -> str:
    if not isinstance(value, str) or not value:
        raise WebUrlIdentityError("URL must be a non-empty string")
    has_forbidden_character = any(
        ord(character) <= 0x20 or ord(character) == 0x7F for character in value
    )
    if value != value.strip() or has_forbidden_character:
        raise WebUrlIdentityError("URL cannot contain whitespace or control characters")
    if len(value.encode("utf-8")) > max_bytes:
        raise WebUrlIdentityError(f"URL cannot exceed {max_bytes} bytes")
    if _INVALID_PERCENT_ESCAPE.search(value):
        raise WebUrlIdentityError("URL contains an invalid percent escape")
    return value


def _normalize_host(host: str) -> str:
    if not host or "%" in host:
        raise WebUrlIdentityError("URL host is invalid")
    candidate = host[:-1] if host.endswith(".") else host
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        try:
            normalized = candidate.encode("idna").decode("ascii").lower()
        except UnicodeError as exc:
            raise WebUrlIdentityError("URL host cannot be normalized") from exc
        if not normalized or len(normalized) > 253:
            raise WebUrlIdentityError("URL host is invalid") from None
        labels = normalized.split(".")
        if any(
            not label
            or len(label) > 63
            or label.startswith("-")
            or label.endswith("-")
            or re.fullmatch(r"[a-z0-9-]+", label) is None
            for label in labels
        ):
            raise WebUrlIdentityError("URL host is invalid") from None
        return normalized
    return address.compressed.lower()


def _normalize_path(path: str) -> str:
    normalized = _normalize_percent_encoding(path, safe="/:@!$&'()*+,;=-._~%")
    normalized = _remove_dot_segments(normalized)
    return normalized or "/"


def _remove_dot_segments(path: str) -> str:
    input_buffer = path
    output = ""
    while input_buffer:
        if input_buffer.startswith("../"):
            input_buffer = input_buffer[3:]
        elif input_buffer.startswith("./"):
            input_buffer = input_buffer[2:]
        elif input_buffer.startswith("/./"):
            input_buffer = "/" + input_buffer[3:]
        elif input_buffer == "/.":
            input_buffer = "/"
        elif input_buffer.startswith("/../"):
            input_buffer = "/" + input_buffer[4:]
            output = output.rsplit("/", 1)[0]
        elif input_buffer == "/..":
            input_buffer = "/"
            output = output.rsplit("/", 1)[0]
        elif input_buffer in {".", ".."}:
            input_buffer = ""
        else:
            start = 1 if input_buffer.startswith("/") else 0
            next_slash = input_buffer.find("/", start)
            if next_slash < 0:
                output += input_buffer
                input_buffer = ""
            else:
                output += input_buffer[:next_slash]
                input_buffer = input_buffer[next_slash:]
    return output


def _redact_parameter_string(value: str) -> str:
    if not value:
        return ""
    normalized = _normalize_percent_encoding(
        value,
        safe="!$'()*+,;:@/?-._~%=&[]",
    )
    parts: list[str] = []
    for part in normalized.split("&"):
        raw_name, separator, raw_value = part.partition("=")
        decoded_name = unquote_plus(raw_name).casefold()
        decoded_value = unquote_plus(raw_value)
        if separator and (
            _is_sensitive_parameter_name(decoded_name)
            or _EMBEDDED_SENSITIVE_PARAMETER.search(decoded_value)
        ):
            parts.append(f"{raw_name}={REDACTED_QUERY_VALUE}")
        else:
            parts.append(part)
    return "&".join(parts)


def _redact_fragment(value: str) -> str:
    if not value:
        return ""
    if "=" in value or "&" in value:
        return _redact_parameter_string(value)
    return _normalize_percent_encoding(value, safe="!$&'()*+,;=:@/?-._~%[]")


def _is_sensitive_parameter_name(name: str) -> bool:
    parts = [part for part in re.split(r"[^a-z0-9]+", name) if part]
    return any(part in _SENSITIVE_PARAMETER_PARTS for part in parts)


def _normalize_percent_encoding(value: str, *, safe: str) -> str:
    if _INVALID_PERCENT_ESCAPE.search(value):
        raise WebUrlIdentityError("URL contains an invalid percent escape")
    encoded = quote(value, safe=safe, encoding="utf-8", errors="strict")
    return _PERCENT_ESCAPE.sub(lambda match: f"%{match.group(1).upper()}", encoded)
