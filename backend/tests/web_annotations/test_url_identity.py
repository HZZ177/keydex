from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from backend.app.web_annotations.url_identity import (
    REDACTED_QUERY_VALUE,
    LOCAL_FILE_ANNOTATION_URL_NORMALIZATION_VERSION,
    WEB_ANNOTATION_URL_NORMALIZATION_VERSION,
    WebUrlIdentityError,
    normalize_local_file_url,
    normalize_web_url,
    sanitize_url_reference,
)

IDENTITY_VECTORS_PATH = (
    Path(__file__).resolve().parents[2]
    / ".."
    / ".dev"
    / "test"
    / "2026-07-23_21-12-15-workbench-browser-file-preview-annotations"
    / "file-identity-vectors.json"
).resolve()


def test_normalizes_idn_default_port_dot_segments_and_fragment() -> None:
    identity = normalize_web_url(
        "HTTPS://BÜCHER.Example:443/a/./b/../c/?page=1&token=secret&code=oauth#api"
    )

    assert identity.normalization_version == 1
    assert identity.origin == "https://xn--bcher-kva.example"
    assert identity.url_normalized == (
        "https://xn--bcher-kva.example/a/c/"
        f"?page=1&token={REDACTED_QUERY_VALUE}&code={REDACTED_QUERY_VALUE}#api"
    )
    assert identity.document_url == identity.url_normalized.removesuffix("#api")
    assert (
        identity.url_key
        == hashlib.sha256(
            f"{WEB_ANNOTATION_URL_NORMALIZATION_VERSION}\n{identity.url_normalized}".encode()
        ).hexdigest()
    )


def test_preserves_business_query_order_duplicates_and_non_default_port() -> None:
    identity = normalize_web_url(
        "http://Example.COM:8080/report/?filter=a&filter=b&monkey=banana&empty="
    )

    assert identity.origin == "http://example.com:8080"
    assert identity.url_normalized == (
        "http://example.com:8080/report/?filter=a&filter=b&monkey=banana&empty="
    )


@pytest.mark.parametrize(
    "name",
    [
        "token",
        "access_token",
        "refresh-token",
        "code",
        "api_key",
        "signature",
        "session_id",
        "Authorization",
        "client_secret",
        "oauth_state",
        "password",
    ],
)
def test_redacts_sensitive_query_parameter_values(name: str) -> None:
    identity = normalize_web_url(f"https://example.com/path?visible=yes&{name}=sensitive")

    assert identity.url_normalized == (
        f"https://example.com/path?visible=yes&{name}={REDACTED_QUERY_VALUE}"
    )
    assert "sensitive" not in identity.url_normalized


def test_redacts_sensitive_oauth_fragment_and_nested_url_value() -> None:
    identity = normalize_web_url(
        "https://example.com/callback?redirect_uri="
        "https%3A%2F%2Fother.example%2F%3Ftoken%3Dnested"
        "#access_token=fragment-secret&token_type=bearer"
    )

    assert f"redirect_uri={REDACTED_QUERY_VALUE}" in identity.url_normalized
    assert f"access_token={REDACTED_QUERY_VALUE}" in identity.url_normalized
    assert "nested" not in identity.url_normalized
    assert "fragment-secret" not in identity.url_normalized


def test_fragment_participates_in_page_identity_but_not_document_url() -> None:
    first = normalize_web_url("https://example.com/docs#one")
    second = normalize_web_url("https://example.com/docs#two")

    assert first.document_url == second.document_url == "https://example.com/docs"
    assert first.url_key != second.url_key


def test_local_file_identity_matches_shared_versioned_vectors() -> None:
    vectors = json.loads(IDENTITY_VECTORS_PATH.read_text(encoding="utf-8"))["vectors"]
    for vector in vectors:
        identity = (
            normalize_web_url(vector["input"])
            if vector["source_kind"] == "web"
            else normalize_local_file_url(vector["input"])
        )
        assert identity.source_kind == vector["source_kind"], vector["name"]
        assert identity.normalization_version == vector["normalization_version"], vector["name"]
        assert identity.url_normalized == vector["url_normalized"], vector["name"]
        assert identity.document_url == vector["document_url"], vector["name"]
        assert identity.origin == vector["origin"], vector["name"]
        assert identity.url_key == vector["url_key"], vector["name"]


def test_local_file_identity_is_case_insensitive_and_fragment_is_page_specific() -> None:
    drive = normalize_local_file_url(r"D:\Workspace\Demo\index.html")
    equivalent = normalize_local_file_url("file:///d:/workspace/demo/index.html")
    fragment = normalize_local_file_url("file:///D:/workspace/demo/index.html#details")

    assert drive.normalization_version == LOCAL_FILE_ANNOTATION_URL_NORMALIZATION_VERSION
    assert drive.url_key == equivalent.url_key
    assert fragment.url_key != equivalent.url_key
    assert fragment.document_url == equivalent.document_url


@pytest.mark.parametrize(
    "value",
    [
        "file:///tmp/index.html",
        "file:///D:/workspace/",
        "file://user:password@server/share/index.html",
        "file:///D:/workspace/%ZZ/index.html",
        "file:///D:/workspace/index.html?token=secret",
        r"D:\..\index.html",
        r"\\server\share",
    ],
)
def test_local_file_identity_rejects_invalid_inputs_without_accessing_disk(value: str) -> None:
    with pytest.raises(WebUrlIdentityError):
        normalize_local_file_url(value)


def test_normalizes_ipv6_and_percent_escape_case() -> None:
    identity = normalize_web_url("http://[2001:0DB8::1]:80/a%2fb?q=%e4%b8%ad")

    assert identity.origin == "http://[2001:db8::1]"
    assert identity.url_normalized == "http://[2001:db8::1]/a%2Fb?q=%E4%B8%AD"


def test_sanitizes_relative_stable_url_attributes() -> None:
    assert sanitize_url_reference("../asset?id=1&signature=secret#preview") == (
        f"../asset?id=1&signature={REDACTED_QUERY_VALUE}#preview"
    )


@pytest.mark.parametrize(
    "value",
    [
        "",
        " mailto:test@example.com",
        "mailto:test@example.com",
        "file:///tmp/secret",
        "https:///missing-host",
        "https://user:password@example.com/",
        "https://example.com:99999/",
        "https://example.com/bad%escape",
        "https://example.com/path\nnext",
        "https://bad_host.example/",
    ],
)
def test_rejects_unsafe_or_invalid_page_urls(value: str) -> None:
    with pytest.raises(WebUrlIdentityError) as error:
        normalize_web_url(value)

    assert error.value.code == "web_annotation_invalid_url"


@pytest.mark.parametrize(
    "value",
    ["javascript:alert(1)", "data:text/plain,secret", "//example.com/a"],
)
def test_rejects_unsafe_stable_url_attribute_schemes(value: str) -> None:
    with pytest.raises(WebUrlIdentityError):
        sanitize_url_reference(value)
