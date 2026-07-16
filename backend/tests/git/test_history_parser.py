from __future__ import annotations

from backend.app.git.history import LOG_FORMAT, parse_git_log


def test_parses_multiline_unicode_commit_merge_parents_decorations_and_signature() -> None:
    payload = (
        "\x1eabcdef00\x00parent1 parent2\x00作者\x00author@example.invalid\x00"
        "2026-07-15T01:02:03+08:00\x00提交者\x00committer@example.invalid\x00"
        "2026-07-15T01:03:04+08:00\x00主题 😀\x00body line 1\nbody line 2\n\x00"
        "HEAD -> main, tag: v1, origin/main\x00G\x00"
    )
    commits = parse_git_log(payload)
    assert len(commits) == 1
    commit = commits[0]
    assert commit.parent_ids == ["parent1", "parent2"]
    assert commit.author_name == "作者"
    assert commit.subject == "主题 😀"
    assert commit.body == "body line 1\nbody line 2"
    assert commit.decorations == ["HEAD -> main", "tag: v1", "origin/main"]
    assert commit.signature == "valid"


def test_parses_real_dag_and_preserves_author_committer_fields(git_repo_factory) -> None:
    repository = git_repo_factory.create("history")
    repository.run("switch", "-c", "feature")
    repository.write("feature.txt", "feature\n")
    repository.run("add", "--", "feature.txt")
    repository.run(
        "-c",
        "user.name=Feature Author",
        "-c",
        "user.email=feature@example.invalid",
        "commit",
        "-m",
        "feature subject",
        "-m",
        "feature body line",
    )
    feature_oid = repository.run("rev-parse", "HEAD").stdout.strip()
    repository.run("switch", "main")
    repository.write("main.txt", "main\n")
    repository.commit("main change", "main.txt")
    repository.run("merge", "--no-ff", "feature", "-m", "merge feature")

    raw = repository.run("log", "--all", "--decorate=full", f"--format={LOG_FORMAT}").stdout
    commits = parse_git_log(raw)
    merge = next(item for item in commits if len(item.parent_ids) == 2)
    feature = next(item for item in commits if item.object_id == feature_oid)
    assert len(merge.parent_ids) == 2
    assert merge.subject == "merge feature"
    assert feature.author_name == "Feature Author"
    assert feature.author_email == "feature@example.invalid"
    assert feature.body == "feature body line"
    assert feature.signature == "unsigned"
