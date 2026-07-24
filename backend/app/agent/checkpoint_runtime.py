from __future__ import annotations

import asyncio
from enum import StrEnum
from pathlib import Path
from typing import Any

import aiosqlite
from fastapi.responses import JSONResponse
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from starlette.types import ASGIApp, Receive, Scope, Send

from backend.app.agent.checkpoint import KeydexAsyncCheckpointStore
from backend.app.agent.checkpoint_migration import (
    CheckpointMigrationCoordinator,
    MigrationStatus,
)
from backend.app.agent.checkpoint_serializer import KeydexCompressedSerializer
from backend.app.storage.db import Database


class CheckpointRuntimeState(StrEnum):
    MIGRATION_REQUIRED = "migration-required"
    MIGRATION_COMPLETED = "migration-completed"
    INSPECTING = "inspecting"
    COPYING = "copying"
    COLLAPSING = "collapsing"
    VERIFYING = "verifying"
    SWAPPING = "swapping"
    SMOKE_CHECKING = "smoke-checking"
    READY = "ready"
    FAILED = "failed"
    CLOSING = "closing"


class CheckpointRuntimeUnavailable(RuntimeError):
    code = "checkpoint_runtime_unavailable"

    def __init__(
        self,
        state: CheckpointRuntimeState,
        *,
        error: str | None = None,
    ) -> None:
        self.state = state
        self.error = error
        super().__init__("会话存储正在准备中，请稍后重试")

    def detail(self) -> dict[str, Any]:
        details: dict[str, Any] = {
            "checkpoint_state": self.state.value,
            "retryable": self.state is not CheckpointRuntimeState.CLOSING,
        }
        if self.error and self.state is CheckpointRuntimeState.FAILED:
            details["reason"] = "checkpoint_runtime_initialization_failed"
        return {
            "code": self.code,
            "message": str(self),
            "details": details,
            "status": 503,
        }


class CheckpointRuntime:
    """Own the single application-lifetime async checkpoint connection."""

    def __init__(
        self,
        database_path: Path | str,
        *,
        serializer: KeydexCompressedSerializer | None = None,
    ) -> None:
        self.database_path = Path(database_path)
        self.state = CheckpointRuntimeState.INSPECTING
        self.error: str | None = None
        self.ready_event = asyncio.Event()
        self.operation_lock = asyncio.Lock()
        self.serializer = serializer or KeydexCompressedSerializer()
        self.migration_coordinator = CheckpointMigrationCoordinator(
            Database(self.database_path)
        )
        self.migration_record = None
        self._connection: aiosqlite.Connection | None = None
        self._official_saver: AsyncSqliteSaver | None = None
        self._store: KeydexAsyncCheckpointStore | None = None

    @property
    def is_ready(self) -> bool:
        return self.state is CheckpointRuntimeState.READY

    @property
    def connection(self) -> aiosqlite.Connection | None:
        return self._connection

    def status_payload(self) -> dict[str, Any]:
        return {
            "state": self.state.value,
            "ready": self.is_ready,
            "error": self.error,
        }

    def transition(
        self,
        state: CheckpointRuntimeState,
        *,
        error: str | None = None,
    ) -> None:
        self.state = state
        self.error = error
        if state is CheckpointRuntimeState.READY:
            self.ready_event.set()
        else:
            self.ready_event.clear()

    async def start(self) -> bool:
        if self._connection is not None:
            migration = await asyncio.to_thread(self.migration_coordinator.inspect)
            self.migration_record = migration
            migration_allows_runtime = migration is None or (
                migration.status is MigrationStatus.COMPLETED
                and migration.ui_acknowledged_at is not None
            )
            if (
                migration_allows_runtime
                and self._official_saver is not None
                and self._store is not None
            ):
                self.transition(CheckpointRuntimeState.READY)
                return True
            if migration is not None:
                self.transition(
                    self._runtime_state_for_migration(migration.status),
                    error=migration.error_code,
                )
            return False
        self.transition(CheckpointRuntimeState.INSPECTING)
        migration = await asyncio.to_thread(self.migration_coordinator.inspect)
        self.migration_record = migration
        if migration is not None:
            if (
                migration.status is MigrationStatus.COMPLETED
                and migration.ui_acknowledged_at is not None
            ):
                pass
            else:
                self.transition(
                    self._runtime_state_for_migration(migration.status),
                    error=migration.error_code,
                )
                return False
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        connection: aiosqlite.Connection | None = None
        try:
            # The official saver normally owns its SQLite file. Keydex deliberately
            # shares app.db with synchronous business repositories, so use
            # autocommit for the saver's one-statement writes. Otherwise cancellation
            # between execute() and the saver's explicit commit() can strand a write
            # transaction and block every business BEGIN IMMEDIATE for 30 seconds.
            connection = await aiosqlite.connect(
                self.database_path,
                timeout=30.0,
                isolation_level=None,
            )
            await connection.execute("PRAGMA foreign_keys = ON")
            await connection.execute("PRAGMA busy_timeout = 30000")
            await connection.execute("PRAGMA journal_mode = WAL")
            await connection.execute("PRAGMA synchronous = NORMAL")
            saver = AsyncSqliteSaver(connection, serde=self.serializer)
            await saver.setup()
        except Exception as exc:
            if connection is not None:
                await connection.close()
            self._connection = None
            self._official_saver = None
            self._store = None
            self.transition(
                CheckpointRuntimeState.FAILED,
                error=str(exc) or exc.__class__.__name__,
            )
            return False

        self._connection = connection
        self._official_saver = saver
        self._store = KeydexAsyncCheckpointStore(
            saver,
            operation_lock=self.operation_lock,
        )
        self.transition(CheckpointRuntimeState.READY)
        return True

    def require_ready(self) -> None:
        if not self.is_ready:
            raise CheckpointRuntimeUnavailable(self.state, error=self.error)

    def require_store(self) -> KeydexAsyncCheckpointStore:
        self.require_ready()
        if self._store is None:
            raise CheckpointRuntimeUnavailable(self.state, error=self.error)
        return self._store

    async def close(self) -> None:
        if self.state is CheckpointRuntimeState.CLOSING and self._connection is None:
            return
        self.transition(CheckpointRuntimeState.CLOSING)
        store = self._store
        if store is not None:
            store.begin_closing()
        async with self.operation_lock:
            connection = self._connection
            self._store = None
            self._official_saver = None
            self._connection = None
            if connection is not None:
                await connection.close()

    @staticmethod
    def _runtime_state_for_migration(
        status: MigrationStatus,
    ) -> CheckpointRuntimeState:
        return {
            MigrationStatus.PENDING: CheckpointRuntimeState.MIGRATION_REQUIRED,
            MigrationStatus.PREFLIGHTING: CheckpointRuntimeState.INSPECTING,
            MigrationStatus.COPYING_BUSINESS_DATA: CheckpointRuntimeState.COPYING,
            MigrationStatus.COLLAPSING_CHECKPOINTS: CheckpointRuntimeState.COLLAPSING,
            MigrationStatus.VERIFYING_TARGET: CheckpointRuntimeState.VERIFYING,
            MigrationStatus.READY_TO_SWAP: CheckpointRuntimeState.VERIFYING,
            MigrationStatus.SWAPPING: CheckpointRuntimeState.SWAPPING,
            MigrationStatus.SMOKE_CHECKING: CheckpointRuntimeState.SMOKE_CHECKING,
            MigrationStatus.COMPLETED: CheckpointRuntimeState.MIGRATION_COMPLETED,
            MigrationStatus.FAILED: CheckpointRuntimeState.FAILED,
        }[status]


class CheckpointReadinessMiddleware:
    """Gate only endpoints that can read or mutate checkpoint state."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    @staticmethod
    def _requires_checkpoint(path: str) -> bool:
        if path.startswith("/agent-base/"):
            return True
        if not path.startswith("/api/sessions/"):
            return False
        return any(
            marker in path
            for marker in (
                "/fork",
                "/reverse",
                "/context-compression",
            )
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"} or not self._requires_checkpoint(
            scope.get("path", "")
        ):
            await self.app(scope, receive, send)
            return

        fastapi_app = scope.get("app")
        runtime = getattr(getattr(fastapi_app, "state", None), "checkpoint_runtime", None)
        if (
            runtime is not None
            and runtime.state
            in {
                CheckpointRuntimeState.INSPECTING,
                CheckpointRuntimeState.MIGRATION_REQUIRED,
                CheckpointRuntimeState.MIGRATION_COMPLETED,
            }
        ):
            # Some ASGI hosts and lightweight TestClient uses do not drive the
            # lifespan protocol. It also covers a migration-completion race:
            # persisted completion is authoritative, so a stale in-memory gate
            # must re-arm the already-open official saver instead of closing the
            # conversation WebSocket forever.
            await runtime.start()
        if runtime is not None and runtime.is_ready:
            fastapi_app.state.checkpointer = runtime.require_store()
        if runtime is None or runtime.is_ready:
            await self.app(scope, receive, send)
            return

        unavailable = CheckpointRuntimeUnavailable(runtime.state, error=runtime.error)
        if scope["type"] == "websocket":
            await send(
                {
                    "type": "websocket.close",
                    "code": 1013,
                    "reason": unavailable.code,
                }
            )
            return

        response = JSONResponse(
            status_code=503,
            content={"detail": unavailable.detail()},
            headers={"Retry-After": "1"},
        )
        await response(scope, receive, send)
