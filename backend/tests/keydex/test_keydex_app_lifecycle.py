from __future__ import annotations

from types import SimpleNamespace

from backend.app import main
from backend.app.core.config import AppSettings
from backend.app.keydex import KeydexCapabilityRuntimeCache
from backend.app.keydex.watcher import KeydexWorkspaceWatcher


def test_kr22_app_orders_provision_cache_watcher_without_empty_catalog_event(
    monkeypatch,
    tmp_path,
) -> None:
    order: list[str] = []
    notifications: list[object] = []

    def provision(**_kwargs):
        order.append("provision")
        return SimpleNamespace(status="empty", diagnostics=())

    class RecordingCache(KeydexCapabilityRuntimeCache):
        def __init__(self, **kwargs) -> None:
            order.append("cache")
            super().__init__(**kwargs)

    class RecordingWatcher(KeydexWorkspaceWatcher):
        def __init__(self, **kwargs) -> None:
            order.append("watcher")
            super().__init__(**kwargs)

    monkeypatch.setattr(main, "provision_bundled_presets", provision)
    monkeypatch.setattr(main, "KeydexCapabilityRuntimeCache", RecordingCache)
    monkeypatch.setattr(main, "KeydexWorkspaceWatcher", RecordingWatcher)

    app = main.create_app(
        AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path),
        keydex_system_root_for_testing=tmp_path / "system",
    )

    assert order == ["provision", "cache", "watcher"]
    assert app.state.keydex_preset_provision_result.status == "empty"
    assert app.state.keydex_workspace_watcher._runtime_cache is app.state.keydex_runtime_cache
    assert notifications == []
