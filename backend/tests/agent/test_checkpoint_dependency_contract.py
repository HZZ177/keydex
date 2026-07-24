from __future__ import annotations

import importlib.metadata
import json
import tomllib
from pathlib import Path

from langgraph.channels import DeltaChannel
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

ROOT = Path(__file__).resolve().parents[3]
BASELINE_PATH = Path(__file__).with_name("checkpoint_dependency_baseline.json")


def test_checkpoint_dependencies_match_declared_contract() -> None:
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    dependencies = set(pyproject["project"]["dependencies"])
    requirements = set(
        line.strip()
        for line in (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )

    expected = {
        "langgraph==1.2.9",
        "langgraph-checkpoint>=4.1,<5",
        "langgraph-checkpoint-sqlite==3.1.0",
        "aiosqlite>=0.20",
        "zstandard>=0.23,<1",
    }
    forbidden = {"langgraph-checkpoint>=2.0,<4.0"}

    assert expected <= dependencies
    assert expected <= requirements
    assert forbidden.isdisjoint(dependencies)
    assert forbidden.isdisjoint(requirements)


def test_checkpoint_dependency_resolution_matches_reviewed_baseline() -> None:
    baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))

    resolved = {
        name: importlib.metadata.version(name)
        for name in baseline
    }

    assert resolved == baseline


def test_official_async_saver_and_public_delta_channel_are_importable() -> None:
    assert AsyncSqliteSaver.__module__ == "langgraph.checkpoint.sqlite.aio"
    assert DeltaChannel.__module__ == "langgraph.channels.delta"
