import pytest

from backend.app.web.policies import (
    WebUrlPolicyError,
    dedupe_web_urls,
    normalize_web_url,
    stable_source_id,
)


def test_normalize_url_canonicalizes_host_port_fragment_and_empty_path() -> None:
    first = normalize_web_url("HTTPS://Example.COM.:443#section")
    second = normalize_web_url("https://example.com/")

    assert first == "https://example.com/"
    assert first == second
    assert stable_source_id(first) == stable_source_id(second)


def test_normalize_url_preserves_meaningful_path_and_query() -> None:
    first = normalize_web_url("https://example.com/docs?a=1&b=2#top")
    second = normalize_web_url("https://example.com/docs?b=2&a=1")

    assert first == "https://example.com/docs?a=1&b=2"
    assert first != second
    assert stable_source_id(first) != stable_source_id(second)


def test_normalize_url_supports_idna_and_ipv6() -> None:
    assert normalize_web_url("https://例子.测试") == "https://xn--fsqu00a.xn--0zwm56d/"
    assert normalize_web_url("https://[2001:db8::1]:443/path") == "https://[2001:db8::1]/path"


@pytest.mark.parametrize(
    "url",
    ["", "file:///tmp/test", "https://", "https://example.com:bad", "not-a-url"],
)
def test_normalize_url_rejects_invalid_inputs(url: str) -> None:
    with pytest.raises(WebUrlPolicyError):
        normalize_web_url(url)


def test_dedupe_urls_preserves_first_seen_order() -> None:
    urls = dedupe_web_urls(
        [
            "https://EXAMPLE.com",
            "https://other.test/a",
            "https://example.com/#fragment",
            "https://other.test/b",
        ]
    )

    assert urls == [
        "https://example.com/",
        "https://other.test/a",
        "https://other.test/b",
    ]


def test_source_id_does_not_embed_url_or_credentials() -> None:
    source_id = stable_source_id("https://user:password@example.com/private?token=value")

    assert source_id.startswith("src_")
    assert len(source_id) == 20
    assert "example" not in source_id
    assert "password" not in source_id
