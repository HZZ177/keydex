"""Provider-neutral web search and fetch domain."""

from backend.app.web.config import (
    ValidatedWebProviderValues,
    WebProviderConfigField,
    WebProviderFieldType,
    WebProviderSelectOption,
    validate_config_field_set,
    validate_provider_values,
)
from backend.app.web.errors import (
    WebErrorCode,
    WebErrorPayload,
    WebProviderError,
    sanitize_web_diagnostic,
    web_error,
    web_error_from_exception,
)
from backend.app.web.models import (
    WebCapability,
    WebFetchItem,
    WebFetchRequest,
    WebFetchResponse,
    WebFetchStatus,
    WebSearchRequest,
    WebSearchResponse,
    WebSource,
    WebTimeRange,
)
from backend.app.web.policies import (
    WebUrlPolicyError,
    dedupe_web_urls,
    normalize_web_url,
    stable_source_id,
)
from backend.app.web.provider import (
    BaseWebProvider,
    WebConnectionCheckResult,
    WebProvider,
    WebProviderContext,
    WebProviderDescriptor,
    ensure_provider_capability,
)
from backend.app.web.registry import (
    WebProviderRegistry,
    WebProviderRegistryError,
    build_default_web_provider_registry,
)

__all__ = [
    "BaseWebProvider",
    "ValidatedWebProviderValues",
    "WebCapability",
    "WebConnectionCheckResult",
    "WebErrorCode",
    "WebErrorPayload",
    "WebFetchItem",
    "WebFetchRequest",
    "WebFetchResponse",
    "WebFetchStatus",
    "WebProviderError",
    "WebProvider",
    "WebProviderConfigField",
    "WebProviderContext",
    "WebProviderDescriptor",
    "WebProviderFieldType",
    "WebProviderRegistry",
    "WebProviderRegistryError",
    "WebProviderSelectOption",
    "WebSearchRequest",
    "WebSearchResponse",
    "WebSource",
    "WebTimeRange",
    "WebUrlPolicyError",
    "build_default_web_provider_registry",
    "dedupe_web_urls",
    "ensure_provider_capability",
    "normalize_web_url",
    "sanitize_web_diagnostic",
    "stable_source_id",
    "validate_config_field_set",
    "validate_provider_values",
    "web_error",
    "web_error_from_exception",
]
