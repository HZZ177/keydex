from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ProtocolModel(BaseModel):
    model_config = ConfigDict(
        populate_by_name=True,
        use_enum_values=True,
        extra="allow",
    )


class ModelSettings(ProtocolModel):
    base_url: str = ""
    api_key: str | None = Field(default=None, repr=False)
    model: str = ""
    timeout_seconds: float = 60.0

    @field_validator("base_url")
    @classmethod
    def normalize_base_url(cls, value: str) -> str:
        return value.strip().rstrip("/")

    @field_validator("model")
    @classmethod
    def normalize_model(cls, value: str) -> str:
        return value.strip()

    @property
    def has_endpoint(self) -> bool:
        return bool(self.base_url and self.model)

    def public_dict(self) -> dict[str, Any]:
        preview = None
        if self.api_key:
            preview = (
                f"{self.api_key[:4]}...{self.api_key[-4:]}"
                if len(self.api_key) > 8
                else "***"
            )
        return {
            "base_url": self.base_url,
            "model": self.model,
            "timeout_seconds": self.timeout_seconds,
            "api_key_set": bool(self.api_key),
            "api_key_preview": preview,
        }


class ModelInfo(ProtocolModel):
    id: str
    owned_by: str | None = None
    raw: dict[str, Any] = Field(default_factory=dict)


class ToolSpec(ProtocolModel):
    name: str
    description: str = ""
    parameters: dict[str, Any] = Field(default_factory=dict)

    def to_openai_tool(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }
