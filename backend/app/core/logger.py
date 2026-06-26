from __future__ import annotations

import logging
import sys
import threading
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from loguru import logger

from backend.app.core.file_path import log_path
from backend.app.core.request_context import trace_id_var

SENSITIVE_KEYS = {
    "api_key",
    "apikey",
    "authorization",
    "access_token",
    "refresh_token",
    "token",
    "password",
    "secret",
}

REDACTED = "***REDACTED***"
DEFAULT_APP_LOG_NAME = "keydex_agent"
DEFAULT_LOG_LEVEL = "INFO"

QUIET_THIRD_PARTY_LOGGERS = (
    "fastapi",
    "httpcore",
    "httpx",
    "openai",
    "starlette",
    "uvicorn",
    "uvicorn.error",
    "watchfiles",
    "watchfiles.main",
    "websockets",
)

DISABLED_THIRD_PARTY_LOGGERS = (
    "uvicorn.access",
)

def trace_id_filter(record: dict[str, Any]) -> bool:
    record["extra"]["trace_id"] = trace_id_var.get()
    return True


def redact_sensitive(value: Any) -> Any:
    if isinstance(value, Mapping):
        redacted: dict[str, Any] = {}
        for key, nested in value.items():
            if str(key).lower() in SENSITIVE_KEYS:
                redacted[str(key)] = REDACTED
            else:
                redacted[str(key)] = redact_sensitive(nested)
        return redacted
    if isinstance(value, list):
        return [redact_sensitive(item) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_sensitive(item) for item in value)
    return value


def configure_logging(
    level: str = DEFAULT_LOG_LEVEL,
    *,
    log_dir: str | Path | None = None,
    app_log_name: str = DEFAULT_APP_LOG_NAME,
) -> None:
    resolved_level = _normalize_level(level)
    resolved_log_dir = Path(log_dir or log_path).expanduser().resolve()
    resolved_log_dir.mkdir(parents=True, exist_ok=True)
    _configure_levels()
    handlers: list[dict[str, Any]] = []
    console_sink = _resolve_console_sink()
    if console_sink is not None:
        handlers.append(
            {
                "sink": console_sink,
                "level": resolved_level,
                "format": (
                    "<green>{time:YYYY-MM-DD HH:mm:ss.SSSS}</green> | "
                    "<cyan>traceId:{extra[trace_id]}</cyan> | "
                    "<green>{module}:{line}</green> | <level>{level}</level> | {message}"
                ),
                "colorize": True,
                "backtrace": False,
                "diagnose": False,
                "enqueue": False,
                "filter": trace_id_filter,
            },
        )
    handlers.append(
        {
            "sink": f"{resolved_log_dir}/{app_log_name}_{{time:YYYY-MM-DD_HH}}.log",
            "level": resolved_level,
            "format": (
                "{time:YYYY-MM-DD HH:mm:ss.SSSS} | traceId:{extra[trace_id]} | "
                "{module}:{line} | {level} | {message}"
            ),
            "rotation": "1 hour",
            "retention": "7 days",
            "compression": "zip",
            "backtrace": True,
            "diagnose": True,
            "enqueue": False,
            "filter": trace_id_filter,
        }
    )
    logger.configure(
        handlers=handlers
    )
    _quiet_third_party_loggers()
    _install_exception_hooks()


def get_logger(_name: str | None = None):
    return logger


def _configure_levels() -> None:
    logger.level("DEBUG", color="<blue>")
    logger.level("INFO", color="<green>")
    logger.level("SUCCESS", color="<bold><green>")
    logger.level("WARNING", color="<yellow>")
    logger.level("ERROR", color="<red>")
    logger.level("CRITICAL", color="<bold><red>")


def _resolve_console_sink() -> Any | None:
    for stream_name in ("stdout", "__stdout__", "stderr", "__stderr__"):
        stream = getattr(sys, stream_name, None)
        if stream is not None:
            return stream
    return None


def _quiet_third_party_loggers() -> None:
    for logger_name in QUIET_THIRD_PARTY_LOGGERS:
        std_logger = logging.getLogger(logger_name)
        std_logger.handlers.clear()
        std_logger.setLevel(logging.WARNING)
        std_logger.propagate = False
    for logger_name in DISABLED_THIRD_PARTY_LOGGERS:
        std_logger = logging.getLogger(logger_name)
        std_logger.handlers.clear()
        std_logger.disabled = True
        std_logger.propagate = False


def _install_exception_hooks() -> None:
    sys.excepthook = handle_uncaught_exception
    if hasattr(threading, "excepthook"):
        threading.excepthook = lambda args: logger.opt(
            exception=(args.exc_type, args.exc_value, args.exc_traceback)
        ).error("线程中未捕获的异常")


def handle_uncaught_exception(
    exc_type: type[BaseException],
    exc_value: BaseException,
    exc_traceback: Any,
) -> None:
    if issubclass(exc_type, KeyboardInterrupt):
        sys.__excepthook__(exc_type, exc_value, exc_traceback)
        return
    logger.opt(exception=(exc_type, exc_value, exc_traceback)).error("未捕获的异常")


def _normalize_level(level: str) -> str:
    candidate = (level or DEFAULT_LOG_LEVEL).upper()
    if candidate in {"TRACE", "DEBUG", "INFO", "SUCCESS", "WARNING", "ERROR", "CRITICAL"}:
        return candidate
    return DEFAULT_LOG_LEVEL


configure_logging()

__all__ = [
    "logger",
    "configure_logging",
    "get_logger",
    "redact_sensitive",
]
