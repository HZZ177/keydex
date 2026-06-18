"""Canonical event pipeline package for the kt-agentloop rewrite."""

from backend.app.events.actions import (
    ChatAction,
    ChatInboundAction,
    CompletedEventItemAction,
    ReplayAction,
)
from backend.app.events.chat_projection import ChatProjection, ChatProjectionAdapter
from backend.app.events.completed_aggregator import TurnCompletedAggregator
from backend.app.events.dispatcher import EventDispatcher, Projection, ProjectionConsumer
from backend.app.events.domain import DomainEvent
from backend.app.events.event_types import (
    CORE_EVENT_TYPES,
    DomainEventType,
    ensure_known_event_type,
)
from backend.app.events.persistence_projection import PersistenceProjection

__all__ = [
    "CORE_EVENT_TYPES",
    "ChatAction",
    "ChatInboundAction",
    "ChatProjection",
    "ChatProjectionAdapter",
    "CompletedEventItemAction",
    "DomainEvent",
    "DomainEventType",
    "EventDispatcher",
    "PersistenceProjection",
    "Projection",
    "ProjectionConsumer",
    "ReplayAction",
    "TurnCompletedAggregator",
    "ensure_known_event_type",
]
