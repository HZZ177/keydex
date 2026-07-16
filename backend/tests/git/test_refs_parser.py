from __future__ import annotations

from backend.app.git.refs import REF_FORMAT, parse_for_each_ref


def test_parses_namespaced_refs_tracking_counts_current_and_peeled_tags() -> None:
    payload = (
        "refs/heads/main\x1fmain\x1faaaaaaaa\x1fcommit\x1frefs/remotes/origin/main"
        "\x1f[ahead 2, behind 3]\x1f*\x1f\x1finitial\x1f2026-01-01T00:00:00Z\x00"
        "refs/remotes/origin/main\x1forigin/main\x1fbbbbbbbb\x1fcommit\x1f\x1f"
        "\x1f \x1f\x1finitial\x1f2026-01-01T00:00:00Z\x00"
        "refs/tags/v1\x1fv1\x1fcccccccc\x1ftag\x1f\x1f\x1f \x1fdddddddd"
        "\x1fversion one\x1f2026-01-02T00:00:00Z\x00"
    )
    refs = parse_for_each_ref(payload)
    assert [(item.kind, item.short_name) for item in refs] == [
        ("local", "main"),
        ("remote", "origin/main"),
        ("tag", "v1"),
    ]
    assert refs[0].model_dump() == {
        "full_name": "refs/heads/main",
        "short_name": "main",
        "kind": "local",
        "object_id": "aaaaaaaa",
        "peeled_object_id": None,
        "upstream": "refs/remotes/origin/main",
        "ahead": 2,
        "behind": 3,
        "current": True,
        "annotated": False,
        "annotation": None,
        "created_at": "2026-01-01T00:00:00Z",
    }
    assert refs[2].peeled_object_id == "dddddddd"
    assert refs[2].annotated is True
    assert refs[2].annotation == "version one"


def test_parses_real_local_remote_and_tag_refs(git_repo_factory) -> None:
    repository = git_repo_factory.create("refs")
    remote = git_repo_factory.create_bare("refs-origin")
    repository.run("remote", "add", "origin", str(remote))
    repository.run("push", "-u", "origin", "main")
    repository.run("tag", "-a", "v1", "-m", "version one")
    repository.run("switch", "-c", "feature")
    repository.write("feature.txt", "feature\n")
    repository.commit("feature", "feature.txt")

    raw = repository.run("for-each-ref", f"--format={REF_FORMAT}").stdout
    refs = parse_for_each_ref(raw)
    by_name = {item.full_name: item for item in refs}
    assert by_name["refs/heads/feature"].current is True
    assert by_name["refs/heads/main"].upstream == "refs/remotes/origin/main"
    assert by_name["refs/remotes/origin/main"].kind == "remote"
    assert by_name["refs/tags/v1"].peeled_object_id is not None
    assert by_name["refs/tags/v1"].annotation == "version one"


def test_uses_unambiguous_short_names_when_local_remote_and_tag_share_a_name(
    git_repo_factory,
) -> None:
    repository = git_repo_factory.create("ambiguous-refs")
    remote = git_repo_factory.create_bare("ambiguous-refs-origin")
    repository.run("remote", "add", "origin", str(remote))
    repository.run("branch", "feature")
    repository.run("tag", "feature")
    repository.run("push", "origin", "refs/heads/feature:refs/heads/feature")
    repository.run("fetch", "origin")

    raw = repository.run("for-each-ref", f"--format={REF_FORMAT}").stdout
    refs = {item.full_name: item for item in parse_for_each_ref(raw)}

    assert refs["refs/heads/feature"].short_name == "feature"
    assert refs["refs/remotes/origin/feature"].short_name == "origin/feature"
    assert refs["refs/tags/feature"].short_name == "feature"
