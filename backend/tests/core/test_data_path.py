from __future__ import annotations

import json

import pytest

from backend.app.core.data_path import managed_data_reference, resolve_data_path


def test_managed_data_reference_round_trips_inside_current_data_root(tmp_path) -> None:
    data_dir = tmp_path / "install" / "data"
    target = data_dir / "attachments" / "a-1" / "image.png"

    reference = managed_data_reference(data_dir, target)

    assert reference == "keydex-data://attachments/a-1/image.png"
    assert resolve_data_path(data_dir, reference) == target.resolve()


def test_legacy_storage_marker_remaps_old_roaming_and_local_paths(tmp_path) -> None:
    data_dir = tmp_path / "install" / "data"
    legacy_roaming = tmp_path / "roaming" / "com.keydex.desktop"
    legacy_local = tmp_path / "local" / "com.keydex.desktop"
    data_dir.mkdir(parents=True)
    (data_dir / ".storage-layout-v2.json").write_text(
        json.dumps(
            {
                "version": 2,
                "legacyRoamingDataDir": str(legacy_roaming),
                "legacyLocalDataDir": str(legacy_local),
            }
        ),
        encoding="utf-8",
    )

    assert resolve_data_path(
        data_dir,
        legacy_roaming / "local-files" / "f-1" / "notes.txt",
    ) == (data_dir / "local-files" / "f-1" / "notes.txt").resolve()
    assert resolve_data_path(
        data_dir,
        legacy_local / "EBWebView" / "Preferences",
    ) == (data_dir / "webview" / "main" / "EBWebView" / "Preferences").resolve()


def test_data_reference_rejects_parent_traversal(tmp_path) -> None:
    with pytest.raises(ValueError, match="invalid Keydex data reference"):
        resolve_data_path(tmp_path / "data", "keydex-data://../outside.txt")
