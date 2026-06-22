from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import uvicorn

from backend.app.core.config import reset_settings_cache


def test_backend_main_uses_import_string_for_reload(monkeypatch, tmp_path) -> None:
    import backend.app.main as backend_main

    calls: list[tuple[Any, dict[str, Any]]] = []

    def fake_run(app: Any, **kwargs: Any) -> None:
        calls.append((app, kwargs))

    monkeypatch.setattr(uvicorn, "run", fake_run)
    monkeypatch.setenv("KEYDEX_HOST", "127.0.0.9")
    monkeypatch.setenv("KEYDEX_PORT", "9876")
    monkeypatch.setenv("KEYDEX_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("KEYDEX_RELOAD", "true")
    reset_settings_cache()
    try:
        backend_main.main()
    finally:
        reset_settings_cache()

    assert calls == [
        (
            "backend.app.main:app",
            {
                "host": "127.0.0.9",
                "port": 9876,
                "reload": True,
                "log_level": "info",
                "access_log": False,
                "log_config": None,
            },
        )
    ]


def test_sidecar_entry_sets_data_dir_and_runs_imported_app(monkeypatch, tmp_path) -> None:
    import backend.app.main as backend_main
    import backend.packaging.agent_server_entry as entry

    calls: list[tuple[Any, dict[str, Any]]] = []
    data_dir = tmp_path / "sidecar-data"

    def fake_run(app: Any, **kwargs: Any) -> None:
        calls.append((app, kwargs))

    monkeypatch.setattr(uvicorn, "run", fake_run)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "agent-server",
            "--host",
            "127.0.0.2",
            "--port",
            "9877",
            "--data-dir",
            str(data_dir),
        ],
    )
    monkeypatch.delenv("KEYDEX_DATA_DIR", raising=False)

    entry.main()

    assert Path(os.environ["KEYDEX_DATA_DIR"]) == data_dir
    assert calls == [
        (
            backend_main.app,
            {
                "host": "127.0.0.2",
                "port": 9877,
                "log_level": "info",
                "access_log": False,
                "log_config": None,
            },
        )
    ]
