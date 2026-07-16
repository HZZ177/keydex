from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, ValidationError

from .locks import run_with_git_lock_retry
from .models import GitApiError, GitCommandRequest, GitCommandResponse
from .operations import GitOperationHandle, GitOperationQueue
from .query_service import GitQueryService, repository_version
from .remote_errors import classify_remote_failure
from .runner import GitCliRunner, GitCommandResult

_RequestT = TypeVar("_RequestT", bound=GitCommandRequest)


class GitCommandRisk(StrEnum):
    SAFE = "safe"
    WRITE = "write"
    DESTRUCTIVE = "destructive"
    HISTORY_REWRITE = "history_rewrite"
    REMOTE_DESTRUCTIVE = "remote_destructive"


@dataclass(frozen=True)
class GitPreparedCommand:
    argv: tuple[str, ...]
    summary: str
    input_text: str | None = None
    timeout_seconds: float = 120
    setup_commands: tuple[tuple[str, ...], ...] = ()
    failure_commands: tuple[tuple[str, ...], ...] = ()
    result_queries: tuple[tuple[str, tuple[str, ...]], ...] = ()
    identity_checks: tuple[tuple[tuple[str, ...], str], ...] = ()
    env: Mapping[str, str] | None = None
    result_data: Mapping[str, Any] | None = None


PrepareCommand = Callable[[_RequestT], GitPreparedCommand]
ParseResult = Callable[[GitCommandResult], dict[str, Any]]
Preflight = Callable[[_RequestT], None]


@dataclass(frozen=True)
class GitCommandDefinition(Generic[_RequestT]):
    name: str
    request_model: type[_RequestT]
    risk: GitCommandRisk
    refresh_domains: frozenset[str]
    prepare: PrepareCommand[_RequestT]
    parse_result: ParseResult = lambda _result: {}
    preflight: Preflight[_RequestT] | None = None
    risk_resolver: Callable[[_RequestT], GitCommandRisk] | None = None
    refresh_on_failure: bool = False

    def risk_for(self, request: _RequestT) -> GitCommandRisk:
        return self.risk_resolver(request) if self.risk_resolver is not None else self.risk


class GitCommandRegistry:
    def __init__(self, definitions: tuple[GitCommandDefinition, ...] = ()) -> None:
        self._definitions: dict[str, GitCommandDefinition] = {}
        for definition in definitions:
            self.register(definition)

    def register(self, definition: GitCommandDefinition) -> None:
        name = definition.name.strip()
        if not name or name in self._definitions:
            raise ValueError(f"Git command is empty or already registered: {name}")
        if not definition.refresh_domains:
            raise ValueError("A Git mutation must declare at least one refresh domain")
        self._definitions[name] = definition

    def get(self, name: str) -> GitCommandDefinition:
        try:
            return self._definitions[name]
        except KeyError as exc:
            raise GitApiError("git_invalid_request", f"Unknown Git command: {name}") from exc

    def describe(self) -> tuple[tuple[str, GitCommandRisk, frozenset[str]], ...]:
        return tuple(
            (definition.name, definition.risk, definition.refresh_domains)
            for definition in self._definitions.values()
        )


class GitCommandService:
    def __init__(
        self,
        *,
        query_service: GitQueryService,
        registry: GitCommandRegistry,
        runner: GitCliRunner | None = None,
        queue: GitOperationQueue | None = None,
        confirmation_validator: Callable[[str, str, GitCommandRequest], bool] | None = None,
    ) -> None:
        self._queries = query_service
        self._registry = registry
        self._runner = runner or GitCliRunner()
        self._queue = queue or GitOperationQueue()
        self._confirmation_validator = confirmation_validator
        self._results: dict[str, GitCommandResponse] = {}
        self._definitions_by_operation: dict[str, GitCommandDefinition] = {}
        self._risks_by_operation: dict[str, GitCommandRisk] = {}

    def submit(
        self,
        name: str,
        payload: GitCommandRequest | Mapping[str, Any],
    ) -> GitOperationHandle[GitCommandResponse]:
        definition = self._registry.get(name)
        request = self._validate_request(definition, payload)
        effective_risk = definition.risk_for(request)
        repository = self._queries.repository(request)
        current_version = repository_version(repository)
        if (
            request.expected_repository_version is not None
            and request.expected_repository_version != current_version
        ):
            raise GitApiError(
                "git_operation_conflict",
                "Repository changed after the command was prepared",
                retryable=True,
                repository_id=repository.id,
                details={"repository_version": current_version},
            )
        if effective_risk in {
            GitCommandRisk.DESTRUCTIVE,
            GitCommandRisk.HISTORY_REWRITE,
            GitCommandRisk.REMOTE_DESTRUCTIVE,
        } and (
            request.confirmation_token is None
            or self._confirmation_validator is None
            or not self._confirmation_validator(request.confirmation_token, name, request)
        ):
            raise GitApiError(
                "git_operation_conflict",
                "This Git command requires a valid confirmation token",
                repository_id=repository.id,
            )
        if definition.preflight is not None:
            definition.preflight(request)
        prepared = definition.prepare(request)
        if not prepared.argv or prepared.argv[0].startswith("-"):
            raise GitApiError("git_invalid_request", "Prepared Git command is invalid")

        async def execute(context) -> GitCommandResponse:
            for argv, expected in prepared.identity_checks:
                identity = await self._runner.run(
                    argv,
                    cwd=repository.root_path,
                    timeout_seconds=20,
                    cancel_event=context.cancel_event,
                )
                if not identity.succeeded or identity.safe_stdout.strip() != expected:
                    raise GitApiError(
                        "git_operation_conflict",
                        "Git reference changed after the operation was prepared; refresh and retry",
                        repository_id=repository.id,
                    )

            async def run_argv(
                argv: tuple[str, ...],
                *,
                input_text: str | None = None,
                timeout_seconds: float = prepared.timeout_seconds,
                cancel_event: asyncio.Event | None = context.cancel_event,
            ) -> GitCommandResult:
                return await self._runner.run(
                    argv,
                    cwd=repository.root_path,
                    env=prepared.env,
                    input_text=input_text,
                    timeout_seconds=timeout_seconds,
                    cancel_event=cancel_event,
                )

            async def run_failure_commands() -> None:
                for argv in prepared.failure_commands:
                    try:
                        await run_with_git_lock_retry(
                            lambda argv=argv: run_argv(
                                argv,
                                timeout_seconds=20,
                                cancel_event=None,
                            )
                        )
                    except Exception:
                        # Preserve the primary Git failure; rollback is best effort.
                        continue

            for argv in prepared.setup_commands:
                setup_result = await run_with_git_lock_retry(
                    lambda argv=argv: run_argv(argv, timeout_seconds=20)
                )
                if setup_result.cancelled:
                    await run_failure_commands()
                    raise asyncio.CancelledError
                if setup_result.timed_out:
                    await run_failure_commands()
                    raise GitApiError("git_timeout", "Git command setup timed out", retryable=True)
                if not setup_result.succeeded:
                    await run_failure_commands()
                    raise GitApiError(
                        "git_failed",
                        setup_result.safe_stderr.strip() or "Git command setup failed",
                        operation_id=context.operation_id,
                        repository_id=repository.id,
                    )

            result = await run_with_git_lock_retry(
                lambda: run_argv(prepared.argv, input_text=prepared.input_text)
            )
            if result.cancelled:
                await run_failure_commands()
                raise asyncio.CancelledError
            if result.timed_out:
                await run_failure_commands()
                raise GitApiError("git_timeout", "Git command timed out", retryable=True)
            if not result.succeeded:
                await run_failure_commands()
                if definition.refresh_on_failure:
                    self._queries.invalidate(repository.id)
                if prepared.argv[0] in {"fetch", "pull", "push", "ls-remote"}:
                    failure = classify_remote_failure(result.safe_stderr)
                    raise GitApiError(
                        failure.code,
                        failure.message,
                        retryable=failure.retryable,
                        operation_id=context.operation_id,
                        repository_id=repository.id,
                        details={
                            "help_action": failure.help_action,
                            "diagnostic": failure.diagnostic,
                        },
                    )
                raise GitApiError(
                    "git_failed",
                    result.safe_stderr.strip() or "Git command failed",
                    operation_id=context.operation_id,
                    repository_id=repository.id,
                )
            parsed_result = {
                **(dict(prepared.result_data) if prepared.result_data is not None else {}),
                **definition.parse_result(result),
            }
            for key, argv in prepared.result_queries:
                query_result = await self._runner.run(
                    argv,
                    cwd=repository.root_path,
                    timeout_seconds=20,
                    cancel_event=context.cancel_event,
                )
                if query_result.succeeded:
                    parsed_result[key] = query_result.safe_stdout.strip()
            self._queries.invalidate(repository.id)
            response = GitCommandResponse(
                operation_id=context.operation_id,
                repository_id=repository.id,
                repository_version=self._queries.version(repository),
                state="succeeded",
                summary=prepared.summary,
                result={
                    **parsed_result,
                    "refresh_domains": sorted(definition.refresh_domains),
                },
            )
            self._results[context.operation_id] = response
            return response

        handle = self._queue.submit(
            repository_id=repository.id,
            idempotency_key=f"{name}:{request.idempotency_key}",
            operation=execute,
        )
        self._definitions_by_operation[handle.operation_id] = definition
        self._risks_by_operation[handle.operation_id] = effective_risk
        return handle

    def cancel(self, operation_id: str) -> bool:
        return self._queue.cancel(operation_id)

    def operation(self, operation_id: str) -> GitCommandResponse:
        try:
            snapshot = self._queue.snapshot(operation_id)
        except KeyError as exc:
            raise GitApiError("git_repository_not_found", "Git operation was not found") from exc
        definition = self._definitions_by_operation.get(operation_id)
        result = self._results.get(operation_id)
        state = snapshot.state if snapshot.state != "cancelling" else "running"
        error_details = snapshot.error_details or {}
        return GitCommandResponse(
            operation_id=operation_id,
            repository_id=snapshot.repository_id,
            repository_version=result.repository_version if result is not None else "pending",
            state=state,
            summary=(
                result.summary
                if result is not None
                else definition.name if definition is not None else "Git operation"
            ),
            command=definition.name if definition is not None else "unknown",
            risk=self._risks_by_operation.get(operation_id, GitCommandRisk.SAFE).value,
            created_at=snapshot.created_at,
            started_at=snapshot.started_at,
            finished_at=snapshot.finished_at,
            duration_ms=_operation_duration_ms(
                snapshot.started_at or snapshot.created_at,
                snapshot.finished_at,
            ),
            retryable=snapshot.retryable,
            error=(
                {
                    "code": snapshot.error_code or "git_failed",
                    "message": snapshot.error,
                    "retryable": snapshot.retryable,
                    "details": error_details,
                }
                if snapshot.error
                else None
            ),
            result=(
                {
                    "error": snapshot.error,
                    "error_code": snapshot.error_code,
                    "retryable": snapshot.retryable,
                    **error_details,
                    **(
                        {"refresh_domains": sorted(definition.refresh_domains)}
                        if definition is not None and definition.refresh_on_failure
                        else {}
                    ),
                }
                if snapshot.error
                else result.result if result is not None else {}
            ),
        )

    @staticmethod
    def _validate_request(
        definition: GitCommandDefinition[_RequestT],
        payload: GitCommandRequest | Mapping[str, Any],
    ) -> _RequestT:
        try:
            if isinstance(payload, definition.request_model):
                return payload
            source = payload.model_dump() if isinstance(payload, BaseModel) else dict(payload)
            return definition.request_model.model_validate(source)
        except (ValidationError, TypeError, ValueError) as exc:
            raise GitApiError("git_validation_failed", str(exc)) from exc


def _operation_duration_ms(started_at: str | None, finished_at: str | None) -> int | None:
    if not started_at or not finished_at:
        return None
    try:
        duration = datetime.fromisoformat(finished_at) - datetime.fromisoformat(started_at)
    except ValueError:
        return None
    return max(0, round(duration.total_seconds() * 1000))
