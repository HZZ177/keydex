from __future__ import annotations

import hashlib
import ipaddress
import re
from dataclasses import dataclass
from urllib.parse import quote, unquote_plus, urlsplit, urlunsplit

WEB_ANNOTATION_URL_NORMALIZATION_VERSION = 1
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
        normalization_version=WEB_ANNOTATION_URL_NORMALIZATION_VERSION,
        url_key=hashlib.sha256(digest_input).hexdigest(),
        url_normalized=url_normalized,
        document_url=document_url,
        origin=origin,
    )


def normalize_page_reference_url(value: str, *, allow_about_blank: bool = False) -> str:
    """Normalize a persisted frame/canonical URL without creating identity aliases."""

    if allow_about_blank and value == "about:blank":
        return value
    return normalize_web_url(value).url_normalized


def sanitize_url_reference(value: str) -> str:
    """Sanitize a stable href/src attribute while preserving relative URL semantics."""

    raw = _validate_raw_url(value, max_bytes=4 * 1024)
    try:
        parsed = urlsplit(raw)
    except ValueError as exc:
        raise WebUrlIdentityError("URL reference cannot be parsed") from exc
    if parsed.scheme:
        if parsed.scheme.lower() not in {"http", "https"}:
            raise WebUrlIdentityError("Stable URL attributes must use http or https")
        return normalize_web_url(raw).url_normalized
    if parsed.netloc:
        raise WebUrlIdentityError("Protocol-relative stable URL attributes are unsupported")
    path = _normalize_percent_encoding(parsed.path, safe="/:@!$&'()*+,;=-._~%")
    query = _redact_parameter_string(parsed.query)
    fragment = _redact_fragment(parsed.fragment)
    return urlunsplit(("", "", path, query, fragment))


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
