from __future__ import annotations

import pytest

from backend.app.web.errors import WebProviderError
from backend.app.web.policies import validate_safe_fetch_url, validate_safe_fetch_urls


@pytest.mark.parametrize(
    ("url", "normalized"),
    [
        ("https://Example.COM:443/docs#section", "https://example.com/docs"),
        ("http://8.8.8.8:80/", "http://8.8.8.8/"),
        ("https://1.1.1.1/path", "https://1.1.1.1/path"),
        ("https://[2606:4700:4700::1111]/dns", "https://[2606:4700:4700::1111]/dns"),
        ("https://例子.测试/path", "https://xn--fsqu00a.xn--0zwm56d/path"),
    ],
)
def test_fetch_url_policy_allows_public_http_urls(url: str, normalized: str) -> None:
    assert validate_safe_fetch_url(url) == normalized


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/file",
        "data:text/plain,secret",
        "javascript:alert(1)",
        "https://user:password@example.com/private",
        "http://localhost",
        "http://sub.localhost/path",
        "http://localhost.localdomain",
        "http://printer.local",
        "http://service.internal",
        "http://router.lan",
        "http://service.home.arpa",
        "http://127.0.0.1",
        "http://127.1",
        "http://2130706433",
        "http://0x7f000001",
        "http://0177.0.0.1",
        "http://10.0.0.1",
        "http://172.16.0.1",
        "http://172.31.255.255",
        "http://192.168.1.1",
        "http://169.254.1.1",
        "http://100.64.0.1",
        "http://0.0.0.0",
        "http://224.0.0.1",
        "http://[::1]",
        "http://[fe80::1]",
        "http://[fc00::1]",
        "http://[::ffff:127.0.0.1]",
        "http://%6c%6f%63%61%6c%68%6f%73%74",
    ],
)
def test_fetch_url_policy_rejects_unsafe_targets(url: str) -> None:
    with pytest.raises(WebProviderError) as caught:
        validate_safe_fetch_url(url)

    assert caught.value.code == "unsafe_url"
    assert url not in str(caught.value.payload.to_public_dict())


def test_fetch_url_policy_preserves_input_order_for_safe_batch() -> None:
    assert validate_safe_fetch_urls(
        ["https://example.com/a", "https://other.test/b"]
    ) == ["https://example.com/a", "https://other.test/b"]


def test_fetch_url_policy_stops_batch_on_first_unsafe_url() -> None:
    with pytest.raises(WebProviderError) as caught:
        validate_safe_fetch_urls(
            ["https://example.com", "http://127.0.0.1", "https://other.test"]
        )

    assert caught.value.code == "unsafe_url"
