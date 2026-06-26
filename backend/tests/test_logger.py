from __future__ import annotations

import sys

from backend.app.core.logger import configure_logging, logger


def test_configure_logging_skips_console_when_standard_streams_missing(
    tmp_path,
    monkeypatch,
) -> None:
    with monkeypatch.context() as stream_patch:
        stream_patch.setattr(sys, "stdout", None)
        stream_patch.setattr(sys, "__stdout__", None)
        stream_patch.setattr(sys, "stderr", None)
        stream_patch.setattr(sys, "__stderr__", None)

        configure_logging(log_dir=tmp_path, app_log_name="no_console")
        logger.info("logger works without a console sink")

    configure_logging(log_dir=tmp_path / "restored", app_log_name="restored")
