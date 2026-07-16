from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest


@dataclass
class GitTestRepository:
    path: Path
    env: dict[str, str]

    def run(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *args],
            cwd=self.path,
            env=self.env,
            check=check,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )

    def write(self, relative_path: str, content: str) -> Path:
        target = self.path / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="")
        return target

    def commit(self, message: str, *paths: str) -> str:
        self.run("add", "--", *(paths or (".",)))
        self.run("commit", "-m", message)
        return self.run("rev-parse", "HEAD").stdout.strip()

    def create_conflict(self, relative_path: str = "conflict.txt") -> None:
        self.write(relative_path, "base\n")
        self.commit("base conflict file", relative_path)
        self.run("switch", "-c", "feature-conflict")
        self.write(relative_path, "feature\n")
        self.commit("feature change", relative_path)
        self.run("switch", "main")
        self.write(relative_path, "main\n")
        self.commit("main change", relative_path)
        result = self.run("merge", "feature-conflict", check=False)
        if result.returncode == 0:
            raise AssertionError("Conflict fixture unexpectedly merged cleanly")


class GitRepoFactory:
    def __init__(self, root: Path) -> None:
        self.root = root
        self._counter = 0
        self.env = os.environ.copy()
        self.env.update(
            {
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_TERMINAL_PROMPT": "0",
                "GCM_INTERACTIVE": "Never",
                "LC_ALL": "C",
                "LANG": "C",
            }
        )

    def create(self, name: str = "repo", *, initial_commit: bool = True) -> GitTestRepository:
        self._counter += 1
        path = self.root / f"e2e-git-{name}-{self._counter}"
        path.mkdir(parents=True)
        repository = GitTestRepository(path=path, env=self.env.copy())
        repository.run("init")
        repository.run("symbolic-ref", "HEAD", "refs/heads/main")
        repository.run("config", "user.name", "Keydex E2E")
        repository.run("config", "user.email", "e2e-git@example.invalid")
        repository.run("config", "commit.gpgsign", "false")
        if initial_commit:
            repository.write("README.md", "# e2e-git fixture\n")
            repository.commit("initial fixture commit", "README.md")
        return repository

    def create_bare(self, name: str = "remote") -> Path:
        self._counter += 1
        path = self.root / f"e2e-git-{name}-{self._counter}.git"
        subprocess.run(
            ["git", "init", "--bare", str(path)],
            cwd=self.root,
            env=self.env,
            check=True,
            capture_output=True,
            stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )
        return path


@pytest.fixture
def git_repo_factory(tmp_path: Path) -> GitRepoFactory:
    return GitRepoFactory(tmp_path)
