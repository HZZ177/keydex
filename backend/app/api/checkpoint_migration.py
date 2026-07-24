from __future__ import annotations

import asyncio
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend.app.agent.checkpoint_migration import (
    CheckpointMigrationError,
    CheckpointMigrationRepository,
    MigrationRecord,
    MigrationStatus,
)
from backend.app.agent.checkpoint_migration_collapse import NamespaceCollapseMigrator
from backend.app.agent.checkpoint_migration_copy import CompactTargetBuilder
from backend.app.agent.checkpoint_migration_swap import AtomicCheckpointDatabaseSwap
from backend.app.agent.checkpoint_runtime import (
    CheckpointRuntime,
    CheckpointRuntimeState,
)
from backend.app.core.logger import logger
from backend.app.storage.db import Database

router = APIRouter(prefix="/api/checkpoint-migration", tags=["checkpoint-migration"])


class PublicMigrationState(StrEnum):
    NOT_REQUIRED = "not_required"
    REQUIRED = "required"
    RUNNING = "running"
    FAILED = "failed"
    COMPLETED = "completed"
    READY = "ready"


class PublicMigrationError(BaseModel):
    code: str
    message: str
    retryable: bool = True


class CheckpointMigrationResponse(BaseModel):
    state: PublicMigrationState
    percent: int
    can_start: bool
    can_retry: bool
    can_acknowledge: bool
    error: PublicMigrationError | None = None


@dataclass(frozen=True)
class _Failure:
    code: str


class CheckpointMigrationController:
    """Run the destructive collapse once and expose only its user-facing contract."""

    def __init__(self, runtime: CheckpointRuntime, database: Database) -> None:
        self.runtime = runtime
        self.database = database
        self._task: asyncio.Task[None] | None = None
        self._task_lock = asyncio.Lock()
        self._status_lock = asyncio.Lock()
        self._database_swapping = False
        self._last_status: CheckpointMigrationResponse | None = None
        self._failure: _Failure | None = None
        self._warmup_task: asyncio.Task[Any] | None = None
        self._following_external_migration = False

    async def status(self) -> CheckpointMigrationResponse:
        if self._following_external_migration:
            file_lock = self.runtime.migration_coordinator.file_lock
            if not file_lock.acquire():
                if self._last_status is not None:
                    return self._last_status
                return CheckpointMigrationResponse(
                    state=PublicMigrationState.RUNNING,
                    percent=0,
                    can_start=False,
                    can_retry=False,
                    can_acknowledge=False,
                )
            file_lock.release()
            self._following_external_migration = False
        if self._database_swapping and self._last_status is not None:
            return self._last_status
        async with self._status_lock:
            if self._database_swapping and self._last_status is not None:
                return self._last_status
            record = await asyncio.to_thread(
                self.runtime.migration_coordinator.inspect
            )
            self.runtime.migration_record = record
            if (
                record is not None
                and record.status is MigrationStatus.PENDING
                and self._task is not None
                and not self._task.done()
            ):
                response = CheckpointMigrationResponse(
                    state=PublicMigrationState.RUNNING,
                    percent=record.user_percent,
                    can_start=False,
                    can_retry=False,
                    can_acknowledge=False,
                )
            else:
                response = self._public_status(record)
            self._last_status = response
            return response

    async def start(self, *, retry: bool = False) -> CheckpointMigrationResponse:
        async with self._task_lock:
            record = await asyncio.to_thread(
                self.runtime.migration_coordinator.inspect
            )
            self.runtime.migration_record = record
            if record is None:
                return self._public_status(None)
            if record.status is MigrationStatus.COMPLETED:
                return self._public_status(record)
            if record.status is MigrationStatus.FAILED and not retry:
                return self._public_status(record)
            if record.status is not MigrationStatus.FAILED and retry:
                return self._public_status(record)
            if self._task is None or self._task.done():
                self._failure = None
                self._task = asyncio.create_task(
                    self._run(
                        retry=retry,
                        resume=record.status
                        not in {
                            MigrationStatus.PENDING,
                            MigrationStatus.FAILED,
                            MigrationStatus.COMPLETED,
                        },
                    ),
                    name="checkpoint-collapse-migration",
                )
        return await self.status()

    async def resume_interrupted(self) -> CheckpointMigrationResponse:
        record = await asyncio.to_thread(
            self.runtime.migration_coordinator.inspect
        )
        if record is None or record.status in {
            MigrationStatus.PENDING,
            MigrationStatus.FAILED,
            MigrationStatus.COMPLETED,
        }:
            return self._public_status(record)
        return await self.start()

    async def acknowledge(self, app_state: Any) -> CheckpointMigrationResponse:
        task = self._task
        if task is not None and not task.done():
            # The swap persists 100% before the controller publishes its final
            # runtime state. Do not let a fast UI acknowledgement start the
            # official saver while the migration task can still overwrite READY.
            await asyncio.shield(task)
        try:
            record = await asyncio.to_thread(
                self.runtime.migration_coordinator.acknowledge
            )
        except CheckpointMigrationError as exc:
            raise _public_http_error(exc) from exc
        self.runtime.migration_record = record
        if not await self.runtime.start():
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "checkpoint_runtime_unavailable",
                    "message": "会话存储正在准备中，请稍后重试",
                    "retryable": True,
                },
                headers={"Retry-After": "1"},
            )
        app_state.checkpointer = self.runtime.require_store()
        dependent_services_starter = getattr(
            app_state,
            "start_checkpoint_dependent_services",
            None,
        )
        if dependent_services_starter is not None:
            await dependent_services_starter()
        provider = getattr(app_state, "agent_runtime_provider", None)
        if provider is not None and (
            self._warmup_task is None or self._warmup_task.done()
        ):
            self._warmup_task = asyncio.create_task(
                provider.warmup_async(),
                name="agent-runtime-post-checkpoint-migration-warmup",
            )
        return self._public_status(record)

    async def close(self) -> None:
        task = self._task
        if task is not None and not task.done():
            # A graceful application close is not a migration cancel command.
            # Let the atomic pipeline reach a durable boundary before shutdown.
            await asyncio.shield(task)
        warmup = self._warmup_task
        if warmup is not None and not warmup.done():
            warmup.cancel()
            try:
                await warmup
            except (asyncio.CancelledError, Exception):
                pass

    async def _run(self, *, retry: bool, resume: bool = False) -> None:
        coordinator = self.runtime.migration_coordinator
        if not coordinator.file_lock.acquire():
            # Another process owns the migration. Its persisted progress remains
            # the source of truth. Do not keep opening app.db while that process
            # crosses the Windows rename window: even a short-lived reader can
            # delay target activation. Poll the OS lock and read the database once
            # the owner has released it.
            self._following_external_migration = True
            previous_percent = (
                self._last_status.percent if self._last_status is not None else 0
            )
            self._last_status = CheckpointMigrationResponse(
                state=PublicMigrationState.RUNNING,
                percent=previous_percent,
                can_start=False,
                can_retry=False,
                can_acknowledge=False,
            )
            return
        try:
            repository = coordinator.repository
            record = await asyncio.to_thread(repository.ensure_required)
            if record is None or record.status is MigrationStatus.COMPLETED:
                return
            if record.status is MigrationStatus.FAILED:
                if not retry:
                    return
                record = await asyncio.to_thread(repository.retry)
            elif resume:
                record = await asyncio.to_thread(repository.resume_interrupted)
            if record.status is not MigrationStatus.PENDING:
                return

            self.runtime.transition(CheckpointRuntimeState.INSPECTING)
            await asyncio.to_thread(repository.preflight)
            self.runtime.transition(CheckpointRuntimeState.COPYING)
            await CompactTargetBuilder(self.database).build()
            self.runtime.transition(CheckpointRuntimeState.COLLAPSING)
            await asyncio.to_thread(
                NamespaceCollapseMigrator(self.database).collapse
            )
            self.runtime.transition(CheckpointRuntimeState.SWAPPING)
            async with self._status_lock:
                self._database_swapping = True
                self._last_status = CheckpointMigrationResponse(
                    state=PublicMigrationState.RUNNING,
                    percent=85,
                    can_start=False,
                    can_retry=False,
                    can_acknowledge=False,
                )
            try:
                await AtomicCheckpointDatabaseSwap(self.database).swap()
                completed = await asyncio.to_thread(
                    CheckpointMigrationRepository(self.database).get
                )
                self.runtime.migration_record = completed
                if not self.runtime.is_ready:
                    self.runtime.transition(
                        CheckpointRuntimeState.MIGRATION_COMPLETED
                    )
                async with self._status_lock:
                    self._last_status = self._public_status(completed)
            finally:
                self._database_swapping = False
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            code = (
                exc.code
                if isinstance(exc, CheckpointMigrationError)
                else "checkpoint_migration_failed"
            )
            self._failure = _Failure(code=code)
            try:
                repository = CheckpointMigrationRepository(self.database)
                record = await asyncio.to_thread(repository.get)
                if record is not None and record.status is not MigrationStatus.FAILED:
                    await asyncio.to_thread(
                        repository.fail,
                        code,
                        f"migration error type={type(exc).__name__}",
                    )
                self.runtime.migration_record = await asyncio.to_thread(repository.get)
            except Exception:
                logger.opt(exception=True).error(
                    "[CheckpointMigration] 无法持久化迁移失败状态"
                )
            self.runtime.transition(CheckpointRuntimeState.FAILED, error=code)
            logger.opt(exception=True).error(
                f"[CheckpointMigration] 迁移失败 | code={code}"
            )
        finally:
            coordinator.file_lock.release()

    def _public_status(
        self,
        record: MigrationRecord | None,
    ) -> CheckpointMigrationResponse:
        if record is None:
            state = (
                PublicMigrationState.READY
                if self.runtime.is_ready
                else PublicMigrationState.NOT_REQUIRED
            )
            return CheckpointMigrationResponse(
                state=state,
                percent=100,
                can_start=False,
                can_retry=False,
                can_acknowledge=False,
            )
        if record.status is MigrationStatus.COMPLETED:
            acknowledged = record.ui_acknowledged_at is not None
            return CheckpointMigrationResponse(
                state=(
                    PublicMigrationState.READY
                    if acknowledged and self.runtime.is_ready
                    else PublicMigrationState.COMPLETED
                ),
                percent=100,
                can_start=False,
                can_retry=False,
                can_acknowledge=not acknowledged,
            )
        if record.status is MigrationStatus.FAILED:
            code = record.error_code or (
                self._failure.code
                if self._failure is not None
                else "checkpoint_migration_failed"
            )
            return CheckpointMigrationResponse(
                state=PublicMigrationState.FAILED,
                percent=record.user_percent,
                can_start=False,
                can_retry=True,
                can_acknowledge=False,
                error=_safe_public_error(code),
            )
        if record.status is MigrationStatus.PENDING:
            return CheckpointMigrationResponse(
                state=PublicMigrationState.REQUIRED,
                percent=record.user_percent,
                can_start=True,
                can_retry=False,
                can_acknowledge=False,
            )
        return CheckpointMigrationResponse(
            state=PublicMigrationState.RUNNING,
            percent=record.user_percent,
            can_start=False,
            can_retry=False,
            can_acknowledge=False,
        )


@router.get("", response_model=CheckpointMigrationResponse)
async def get_checkpoint_migration(
    request: Request,
) -> CheckpointMigrationResponse:
    return await _controller(request).status()


@router.post("/start", response_model=CheckpointMigrationResponse)
async def start_checkpoint_migration(
    request: Request,
) -> CheckpointMigrationResponse:
    return await _controller(request).start()


@router.post("/retry", response_model=CheckpointMigrationResponse)
async def retry_checkpoint_migration(
    request: Request,
) -> CheckpointMigrationResponse:
    return await _controller(request).start(retry=True)


@router.post("/acknowledge", response_model=CheckpointMigrationResponse)
async def acknowledge_checkpoint_migration(
    request: Request,
) -> CheckpointMigrationResponse:
    return await _controller(request).acknowledge(request.app.state)


def _controller(request: Request) -> CheckpointMigrationController:
    controller = getattr(
        request.app.state,
        "checkpoint_migration_controller",
        None,
    )
    if controller is None:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "checkpoint_migration_unavailable",
                "message": "会话数据迁移服务尚未就绪",
                "retryable": True,
            },
            headers={"Retry-After": "1"},
        )
    return controller


def _safe_public_error(code: str) -> PublicMigrationError:
    messages = {
        "checkpoint_migration_insufficient_space": "可用磁盘空间不足，请清理空间后重试",
        "checkpoint_migration_locked": "另一个 Keydex 进程正在迁移会话数据，请稍后重试",
        "checkpoint_migration_source_changed": (
            "会话数据在迁移期间发生变化，请重新启动 Keydex 后重试"
        ),
    }
    return PublicMigrationError(
        code=code,
        message=messages.get(code, "会话数据迁移未完成，请重试"),
    )


def _public_http_error(exc: CheckpointMigrationError) -> HTTPException:
    public = _safe_public_error(exc.code)
    return HTTPException(
        status_code=409,
        detail=public.model_dump(),
    )
