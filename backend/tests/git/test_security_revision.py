from __future__ import annotations

import pytest

from backend.app.git.security import GitParameterError, validate_revision


@pytest.mark.parametrize(
    "revision",
    ["HEAD~1", "HEAD^^", "main^2", "feature/topic~12", "HEAD@{1}", "main@{24}~2"],
)
def test_validate_revision_allows_numeric_ancestry_and_reflog_suffixes(revision: str) -> None:
    assert validate_revision(revision) == revision


@pytest.mark.parametrize(
    "revision",
    ["--all", "HEAD^{commit}", "HEAD@{now}", "HEAD~x", "main..topic", "main:path"],
)
def test_validate_revision_rejects_option_and_advanced_rev_parse_syntax(revision: str) -> None:
    with pytest.raises(GitParameterError):
        validate_revision(revision)
