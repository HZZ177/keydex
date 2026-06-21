from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass

trace_id_var: ContextVar[str] = ContextVar("trace_id", default="")
session_id_var: ContextVar[str] = ContextVar("session_id", default="")
active_session_id_var: ContextVar[str] = ContextVar("active_session_id", default="")
user_id_var: ContextVar[str] = ContextVar("user_id", default="")


@dataclass(frozen=True)
class RequestContextToken:
    trace_id: Token[str] | None = None
    session_id: Token[str] | None = None
    active_session_id: Token[str] | None = None
    user_id: Token[str] | None = None


def set_request_context(
    *,
    trace_id: str | None = None,
    session_id: str | None = None,
    active_session_id: str | None = None,
    user_id: str | None = None,
) -> RequestContextToken:
    return RequestContextToken(
        trace_id=trace_id_var.set(trace_id) if trace_id is not None else None,
        session_id=session_id_var.set(session_id) if session_id is not None else None,
        active_session_id=active_session_id_var.set(active_session_id)
        if active_session_id is not None
        else None,
        user_id=user_id_var.set(user_id) if user_id is not None else None,
    )


def reset_request_context(token: RequestContextToken) -> None:
    if token.user_id is not None:
        user_id_var.reset(token.user_id)
    if token.active_session_id is not None:
        active_session_id_var.reset(token.active_session_id)
    if token.session_id is not None:
        session_id_var.reset(token.session_id)
    if token.trace_id is not None:
        trace_id_var.reset(token.trace_id)


def get_trace_id() -> str:
    return trace_id_var.get()


def get_session_id() -> str:
    return session_id_var.get()


def get_active_session_id() -> str:
    return active_session_id_var.get() or session_id_var.get()


def get_user_id() -> str:
    return user_id_var.get()
