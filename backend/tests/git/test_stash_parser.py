import pytest

from backend.app.git.stash import GitStashParseError, parse_stash_list


def test_stash_parser_preserves_selector_oid_base_message_and_date() -> None:
    payload = (
        "stash@{0}\x00aaaaaaaa\x00bbbbbbbb cccccccc\x00Ada\x00"
        "2026-07-16T02:00:00+08:00\x00On main: work in progress\x00"
    )
    entry = parse_stash_list(payload)[0]
    assert entry.selector == "stash@{0}"
    assert entry.object_id == "aaaaaaaa"
    assert entry.base_object_id == "bbbbbbbb"
    assert entry.author_name == "Ada"
    assert entry.message == "On main: work in progress"

    with pytest.raises(GitStashParseError, match="incomplete"):
        parse_stash_list("stash@{0}\x00deadbeef")
