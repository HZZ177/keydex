from __future__ import annotations

import json
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
MANIFEST_PATH = REPOSITORY_ROOT / "docs" / "decisions" / "subagent-runtime-references.json"
EXPECTED_REFS = {
    "CX-SPAWN",
    "CX-MESSAGE",
    "CX-WAIT",
    "CX-PATH",
    "CX-CONTROL",
    "CX-WATCHER",
    "CX-ROLE",
    "CX-STATUS",
    "CC-TASK-SCHEMA",
    "CC-TASK-LOOP",
    "CC-TASK-CALL",
    "BASE-DEEP",
    "BASE-DYNAMIC",
}


def _load_manifest() -> dict[str, object]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def test_reference_manifest_has_unique_complete_source_contracts() -> None:
    manifest = _load_manifest()
    sources = manifest["sources"]
    assert isinstance(sources, list)

    ids = [source["id"] for source in sources]
    assert set(ids) == EXPECTED_REFS
    assert len(ids) == len(set(ids))

    for source in sources:
        assert source["revision"].strip()
        assert source["path"].strip()
        assert source["behavior"].strip()
        assert source["keydex_decision"].strip()
        start, end = source["lines"]
        assert 1 <= start <= end


def test_local_reference_files_and_line_ranges_exist() -> None:
    sources = _load_manifest()["sources"]

    for source in sources:
        source_path = Path(source["root"]) / source["path"]
        assert source_path.is_file(), f"missing source for {source['id']}: {source_path}"
        line_count = sum(1 for _ in source_path.open(encoding="utf-8"))
        assert source["lines"][1] <= line_count, (
            f"stale line range for {source['id']}: "
            f"{source['lines']} exceeds {line_count} lines"
        )
