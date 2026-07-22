from __future__ import annotations

from typing import Any

from backend.app.right_sidebar.models import (
    PromotionSourceScopeKind,
    RightSidebarPromotionResponse,
    RightSidebarScopeRecord,
    RightSidebarScopeStateDocument,
    ScopeKind,
)
from backend.app.right_sidebar.repository import (
    RightSidebarRevisionConflict,
    RightSidebarScopeRepository,
)


class RightSidebarServiceError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


class RightSidebarScopeService:
    def __init__(self, repositories) -> None:
        self._repositories = repositories
        self._scopes: RightSidebarScopeRepository = repositories.right_sidebar_scopes

    def get(self, *, scope_kind: ScopeKind, scope_id: str | None) -> RightSidebarScopeRecord | None:
        self._require_scope(scope_kind, scope_id)
        return self._scopes.get(scope_kind=scope_kind, scope_id=scope_id)

    def put(
        self,
        *,
        scope_kind: ScopeKind,
        scope_id: str | None,
        state: RightSidebarScopeStateDocument,
        expected_revision: int,
    ) -> RightSidebarScopeRecord:
        self._require_scope(scope_kind, scope_id)
        try:
            return self._scopes.put(
                scope_kind=scope_kind,
                scope_id=scope_id,
                state=state,
                expected_revision=expected_revision,
            )
        except RightSidebarRevisionConflict as exc:
            raise RightSidebarServiceError(
                "right_sidebar_revision_conflict",
                "右侧栏作用域状态已被更新，请重新加载",
                {
                    "expected_revision": expected_revision,
                    "current": exc.current.model_dump(by_alias=True) if exc.current else None,
                },
            ) from exc

    def delete(self, *, scope_kind: ScopeKind, scope_id: str | None) -> None:
        self._require_scope(scope_kind, scope_id)
        if not self._scopes.delete(scope_kind=scope_kind, scope_id=scope_id):
            raise RightSidebarServiceError(
                "right_sidebar_scope_not_found",
                "右侧栏作用域状态不存在",
                {"scope_kind": scope_kind, "scope_id": scope_id},
            )

    def promote(
        self,
        *,
        source_scope_kind: PromotionSourceScopeKind,
        source_scope_id: str | None,
        source_revision: int,
        target_session_id: str,
    ) -> RightSidebarPromotionResponse:
        self._require_scope(source_scope_kind, source_scope_id)
        self._require_scope("session", target_session_id)
        try:
            return self._scopes.promote(
                source_scope_kind=source_scope_kind,
                source_scope_id=source_scope_id,
                source_revision=source_revision,
                target_session_id=target_session_id,
            )
        except RightSidebarRevisionConflict as exc:
            raise RightSidebarServiceError(
                "right_sidebar_promotion_source_conflict",
                "临时右侧栏状态已变化，请重试发送",
                {
                    "source_revision": source_revision,
                    "current": exc.current.model_dump(by_alias=True) if exc.current else None,
                },
            ) from exc

    def _require_scope(self, scope_kind: ScopeKind, scope_id: str | None) -> None:
        if scope_kind == "global":
            if scope_id is not None:
                raise RightSidebarServiceError(
                    "right_sidebar_scope_invalid",
                    "全局作用域不能携带 scope_id",
                )
            return
        cleaned = (scope_id or "").strip()
        if not cleaned:
            raise RightSidebarServiceError("right_sidebar_scope_invalid", "作用域 ID 不能为空")
        if scope_kind == "session":
            if self._repositories.sessions.get(cleaned, include_internal=True) is None:
                raise RightSidebarServiceError("right_sidebar_scope_parent_not_found", "会话不存在")
            return
        if self._repositories.workspaces.get(cleaned) is None:
            raise RightSidebarServiceError("right_sidebar_scope_parent_not_found", "工作区不存在")
