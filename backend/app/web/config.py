from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from pydantic import Field, field_validator, model_validator

from backend.app.core.logger import REDACTED
from backend.app.web.errors import WebErrorCode, WebProviderError, web_error
from backend.app.web.models import WebDomainModel

_CONFIG_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class WebProviderFieldType(StrEnum):
    TEXT = "text"
    SECRET = "secret"
    SELECT = "select"
    BOOLEAN = "boolean"


class WebSecretAction(StrEnum):
    KEEP = "keep"
    SET = "set"
    CLEAR = "clear"


class WebSecretUpdate(WebDomainModel):
    action: WebSecretAction
    value: str | None = Field(default=None, repr=False, max_length=4000)

    @model_validator(mode="after")
    def validate_action_value(self) -> WebSecretUpdate:
        if self.action == WebSecretAction.SET:
            if not self.value or not self.value.strip():
                raise ValueError("set 操作必须提供非空密钥")
            object.__setattr__(self, "value", self.value.strip())
        elif self.value is not None:
            raise ValueError(f"{self.action} 操作不能携带密钥值")
        return self


class WebSecretState(WebDomainModel):
    configured: bool
    preview: str | None = None


class WebProviderSelectOption(WebDomainModel):
    value: str = Field(min_length=1, max_length=120)
    label: str = Field(min_length=1, max_length=120)


class WebProviderConfigField(WebDomainModel):
    key: str = Field(min_length=1, max_length=64)
    field_type: WebProviderFieldType
    label: str = Field(min_length=1, max_length=120)
    required: bool = False
    placeholder: str | None = Field(default=None, max_length=240)
    help_text: str | None = Field(default=None, max_length=400)
    default: str | bool | None = None
    options: tuple[WebProviderSelectOption, ...] = ()

    @field_validator("key")
    @classmethod
    def validate_key(cls, value: str) -> str:
        if not _CONFIG_KEY_PATTERN.fullmatch(value):
            raise ValueError("配置字段 key 必须匹配 ^[a-z][a-z0-9_]{0,63}$")
        return value

    @model_validator(mode="after")
    def validate_field_contract(self) -> WebProviderConfigField:
        if self.field_type == WebProviderFieldType.SECRET:
            if self.default is not None:
                raise ValueError("secret 字段不能声明默认值")
            if self.options:
                raise ValueError("secret 字段不能声明 options")
        elif self.field_type == WebProviderFieldType.SELECT:
            if not self.options:
                raise ValueError("select 字段必须声明 options")
            values = [option.value for option in self.options]
            if len(values) != len(set(values)):
                raise ValueError("select options.value 不能重复")
            if self.default is not None and self.default not in values:
                raise ValueError("select 默认值必须存在于 options")
        elif self.options:
            raise ValueError("只有 select 字段可以声明 options")

        if self.field_type == WebProviderFieldType.BOOLEAN:
            if self.default is not None and not isinstance(self.default, bool):
                raise ValueError("boolean 默认值必须是布尔值")
        elif self.default is not None and not isinstance(self.default, str):
            raise ValueError("非 boolean 字段默认值必须是字符串")
        return self


@dataclass(frozen=True, repr=False)
class ValidatedWebProviderValues:
    config: dict[str, str | bool]
    secrets: dict[str, str]


def validate_config_field_set(
    fields: tuple[WebProviderConfigField, ...],
) -> tuple[WebProviderConfigField, ...]:
    keys = [field.key for field in fields]
    if len(keys) != len(set(keys)):
        raise ValueError("Provider 配置字段 key 不能重复")
    return fields


def validate_provider_values(
    fields: tuple[WebProviderConfigField, ...],
    *,
    config: dict[str, Any] | None = None,
    secrets: dict[str, str] | None = None,
    require_complete: bool = True,
) -> ValidatedWebProviderValues:
    validate_config_field_set(fields)
    config_input = dict(config or {})
    secret_input = dict(secrets or {})
    field_map = {field.key: field for field in fields}
    ordinary_keys = {
        field.key for field in fields if field.field_type != WebProviderFieldType.SECRET
    }
    secret_keys = {
        field.key for field in fields if field.field_type == WebProviderFieldType.SECRET
    }
    unknown = sorted((set(config_input) - ordinary_keys) | (set(secret_input) - secret_keys))
    misplaced = sorted((set(config_input) & secret_keys) | (set(secret_input) & ordinary_keys))
    if unknown or misplaced:
        raise WebProviderError(
            web_error(
                WebErrorCode.INVALID_REQUEST,
                diagnostic={"unknown_fields": unknown, "misplaced_fields": misplaced},
            )
        )

    validated_config: dict[str, str | bool] = {}
    validated_secrets: dict[str, str] = {}
    missing: list[str] = []

    for key, field in field_map.items():
        if field.field_type == WebProviderFieldType.SECRET:
            value = str(secret_input.get(key) or "").strip()
            if value:
                validated_secrets[key] = value
            elif field.required:
                missing.append(key)
            continue

        raw_value = config_input.get(key, field.default)
        if field.field_type == WebProviderFieldType.BOOLEAN:
            if raw_value is None and not field.required:
                continue
            if not isinstance(raw_value, bool):
                _raise_invalid_field(key)
            validated_config[key] = raw_value
            continue

        if raw_value is not None and not isinstance(raw_value, str):
            _raise_invalid_field(key)
        value = str(raw_value or "").strip()
        if not value:
            if field.required:
                missing.append(key)
            continue
        if field.field_type == WebProviderFieldType.SELECT:
            allowed = {option.value for option in field.options}
            if value not in allowed:
                _raise_invalid_field(key)
        validated_config[key] = value

    if missing and require_complete:
        raise WebProviderError(
            web_error(
                WebErrorCode.PROVIDER_NOT_CONFIGURED,
                diagnostic={"missing_fields": sorted(missing)},
            )
        )
    return ValidatedWebProviderValues(config=validated_config, secrets=validated_secrets)


def apply_secret_updates(
    fields: tuple[WebProviderConfigField, ...],
    *,
    current: Mapping[str, str] | None,
    updates: Mapping[str, WebSecretUpdate] | None,
) -> dict[str, str]:
    validate_config_field_set(fields)
    secret_keys = {
        field.key for field in fields if field.field_type == WebProviderFieldType.SECRET
    }
    update_input = dict(updates or {})
    unknown = sorted(set(update_input) - secret_keys)
    if unknown:
        raise WebProviderError(
            web_error(
                WebErrorCode.INVALID_REQUEST,
                diagnostic={"unknown_secret_fields": unknown},
            )
        )

    resolved = {str(key): str(value) for key, value in (current or {}).items() if value}
    for key, update in update_input.items():
        if update.action == WebSecretAction.KEEP:
            continue
        if update.action == WebSecretAction.CLEAR:
            resolved.pop(key, None)
            continue
        if update.value is None:  # pragma: no cover - enforced by the DTO
            raise ValueError("set 操作缺少密钥值")
        resolved[key] = update.value
    return resolved


def describe_secret_states(
    fields: tuple[WebProviderConfigField, ...],
    secrets: Mapping[str, str] | None,
) -> dict[str, WebSecretState]:
    stored = secrets or {}
    return {
        field.key: WebSecretState(
            configured=bool(stored.get(field.key)),
            preview=_secret_preview(stored.get(field.key)),
        )
        for field in fields
        if field.field_type == WebProviderFieldType.SECRET
    }


def redact_configured_secrets(value: Any, secrets: Mapping[str, str] | None) -> Any:
    sensitive_values = tuple(secret for secret in (secrets or {}).values() if secret)
    if isinstance(value, Mapping):
        return {
            str(key): (
                REDACTED
                if str(key) in (secrets or {})
                else redact_configured_secrets(nested, secrets)
            )
            for key, nested in value.items()
        }
    if isinstance(value, list):
        return [redact_configured_secrets(item, secrets) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_configured_secrets(item, secrets) for item in value)
    if isinstance(value, str):
        redacted = value
        for secret in sensitive_values:
            redacted = redacted.replace(secret, REDACTED)
        return redacted
    return value


def _secret_preview(value: str | None) -> str | None:
    if not value:
        return None
    if len(value) <= 8:
        return "***"
    return f"{value[:4]}...{value[-4:]}"


def _raise_invalid_field(key: str) -> None:
    raise WebProviderError(
        web_error(
            WebErrorCode.INVALID_REQUEST,
            diagnostic={"invalid_field": key},
        )
    )
