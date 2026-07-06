from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.types import McpErrorCode
from backend.app.storage import (
    McpResourceRecord,
    McpResourceTemplateRecord,
    StorageRepositories,
)


@dataclass(frozen=True)
class McpResourceSummary:
    uri: str
    reserved_only: bool
    name: str | None = None
    description: str | None = None
    mime_type: str | None = None
    meta: dict[str, Any] | None = None

    @classmethod
    def from_record(cls, record: McpResourceRecord) -> McpResourceSummary:
        return cls(
            uri=record.uri,
            reserved_only=record.reserved_only,
            name=record.name,
            description=record.description,
            mime_type=record.mime_type,
            meta=record.meta,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "uri": self.uri,
            "reserved_only": self.reserved_only,
            "name": self.name,
            "description": self.description,
            "mime_type": self.mime_type,
            "meta": self.meta,
        }


@dataclass(frozen=True)
class McpResourceTemplateSummary:
    uri_template: str
    reserved_only: bool
    name: str | None = None
    description: str | None = None
    mime_type: str | None = None
    meta: dict[str, Any] | None = None

    @classmethod
    def from_record(cls, record: McpResourceTemplateRecord) -> McpResourceTemplateSummary:
        return cls(
            uri_template=record.uri_template,
            reserved_only=record.reserved_only,
            name=record.name,
            description=record.description,
            mime_type=record.mime_type,
            meta=record.meta,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "uri_template": self.uri_template,
            "reserved_only": self.reserved_only,
            "name": self.name,
            "description": self.description,
            "mime_type": self.mime_type,
            "meta": self.meta,
        }


class McpResourcesReservedService:
    def __init__(self, repositories: StorageRepositories) -> None:
        self.repositories = repositories

    def list_resources_reserved(self, server_id: str) -> list[McpResourceSummary]:
        self._require_server(server_id)
        return [
            McpResourceSummary.from_record(record)
            for record in self.repositories.mcp_resources.list_resources(server_id)
        ]

    def list_resource_templates_reserved(
        self,
        server_id: str,
    ) -> list[McpResourceTemplateSummary]:
        self._require_server(server_id)
        return [
            McpResourceTemplateSummary.from_record(record)
            for record in self.repositories.mcp_resources.list_templates(server_id)
        ]

    def read_resource_reserved(self, server_id: str, uri: str) -> None:
        self._require_server(server_id)
        raise McpRuntimeError(
            McpErrorCode.RESOURCE_RESERVED,
            detail={
                "server_id": server_id,
                "uri": uri,
                "reserved_only": True,
            },
        )

    def _require_server(self, server_id: str) -> None:
        if self.repositories.mcp_servers.get(server_id) is None:
            raise McpRuntimeError(
                McpErrorCode.SERVER_NOT_FOUND,
                detail={"server_id": server_id},
            )
