from backend.app.git.remotes import parse_remote_verbose


def test_remote_verbose_parser_keeps_fetch_push_and_tracking_separate() -> None:
    remotes = parse_remote_verbose(
        "origin\tD:/fetch.git (fetch)\norigin\tD:/push.git (push)\n",
        {"origin": ["release", "main"]},
    )
    assert [remote.model_dump() for remote in remotes] == [{
        "name": "origin",
        "fetch_url": "D:/fetch.git",
        "push_url": "D:/push.git",
        "tracking_branches": ["main", "release"],
    }]
