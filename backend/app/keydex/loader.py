from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from backend.app.core.time import utc_now
from backend.app.keydex.capabilities.base import (
    CapabilityLoadResult,
    KeydexCapability,
    KeydexCapabilityLoadError,
)
from backend.app.keydex.models import (
    CapabilityLayerSnapshot,
    KeydexDiagnostic,
    KeydexLayerDescriptor,
    KeydexLayerSnapshot,
    KeydexScope,
)
from backend.app.keydex.registry import (
    DEFAULT_KEYDEX_CAPABILITY_REGISTRY,
    KeydexCapabilityRegistry,
)
from backend.app.keydex.runtime import (
    KeydexCapabilityFingerprint,
    KeydexLayerFingerprint,
    KeydexSnapshotUnstableError,
    build_keydex_layer_fingerprint,
)

FingerprintBuilder = Callable[[KeydexScope, Path], KeydexLayerFingerprint]


class KeydexLayerLoader:
    """Capture every registered capability from one stable physical layer."""

    def __init__(
        self,
        *,
        registry: KeydexCapabilityRegistry = DEFAULT_KEYDEX_CAPABILITY_REGISTRY,
        attempts: int = 3,
        fingerprint_builder: FingerprintBuilder | None = None,
    ) -> None:
        self.registry = registry
        self.attempts = max(1, attempts)
        self._fingerprint_builder = fingerprint_builder or self._build_fingerprint

    def load(self, descriptor: KeydexLayerDescriptor) -> KeydexLayerSnapshot:
        for _attempt in range(1, self.attempts + 1):
            before = self._fingerprint_builder(descriptor.scope, descriptor.root)
            capabilities = self._capture_capabilities(descriptor, before)
            after = self._fingerprint_builder(descriptor.scope, descriptor.root)
            if before.digest() != after.digest():
                continue
            diagnostics = tuple(
                diagnostic
                for snapshot in capabilities.values()
                for diagnostic in snapshot.diagnostics
            )
            return KeydexLayerSnapshot(
                descriptor=descriptor,
                capabilities=capabilities,
                fingerprint=after.digest(),
                loaded_at=utc_now(),
                diagnostics=diagnostics,
            )
        raise KeydexSnapshotUnstableError(
            f"{descriptor.scope} Keydex layer changed during stable capture",
            scope=descriptor.scope,
        )

    def _capture_capabilities(
        self,
        descriptor: KeydexLayerDescriptor,
        fingerprint: KeydexLayerFingerprint,
    ) -> dict[str, CapabilityLayerSnapshot]:
        fingerprints = {
            item.capability_id: item for item in fingerprint.capabilities
        }
        root_invalid = (
            fingerprint.root_evidence.state != "missing"
            and fingerprint.root_evidence.kind != "directory"
        )
        captured: dict[str, CapabilityLayerSnapshot] = {}
        for capability in self.registry:
            capability_fingerprint = fingerprints.get(capability.id)
            if descriptor.scope not in capability.supported_scopes:
                captured[capability.id] = CapabilityLayerSnapshot(
                    capability_id=capability.id,
                    scope=descriptor.scope,
                    payload=None,
                    fingerprint="",
                    supported=False,
                    state="unsupported",
                )
                continue
            if root_invalid:
                diagnostic = KeydexDiagnostic(
                    code="keydex_root_invalid",
                    reason="Keydex layer root is not a directory",
                    severity="error",
                    capability_id=capability.id,
                    scope=descriptor.scope,
                    logical_path=descriptor.logical_root,
                )
                captured[capability.id] = self._failed_snapshot(
                    capability=capability,
                    descriptor=descriptor,
                    fingerprint=capability_fingerprint,
                    diagnostic=diagnostic,
                )
                continue
            try:
                result = capability.load_layer(
                    scope=descriptor.scope,
                    root=descriptor.root,
                )
                if not isinstance(result, CapabilityLoadResult):
                    raise TypeError(
                        f"{capability.id}.load_layer must return CapabilityLoadResult"
                    )
            except KeydexCapabilityLoadError as exc:
                diagnostic = KeydexDiagnostic(
                    code=exc.code,
                    reason=exc.reason,
                    severity="error",
                    details=exc.details,
                    capability_id=capability.id,
                    scope=descriptor.scope,
                    logical_path=exc.logical_path or descriptor.logical_root,
                )
                captured[capability.id] = self._failed_snapshot(
                    capability=capability,
                    descriptor=descriptor,
                    fingerprint=capability_fingerprint,
                    diagnostic=diagnostic,
                )
                continue
            except OSError:
                diagnostic = KeydexDiagnostic(
                    code="keydex_capability_io_error",
                    reason="Capability source could not be captured",
                    severity="error",
                    capability_id=capability.id,
                    scope=descriptor.scope,
                    logical_path=descriptor.logical_root,
                )
                captured[capability.id] = self._failed_snapshot(
                    capability=capability,
                    descriptor=descriptor,
                    fingerprint=capability_fingerprint,
                    diagnostic=diagnostic,
                )
                continue
            evidence = capability_fingerprint.evidence if capability_fingerprint else ()
            captured[capability.id] = CapabilityLayerSnapshot(
                capability_id=capability.id,
                scope=descriptor.scope,
                payload=result.payload,
                fingerprint=capability_fingerprint.digest()
                if capability_fingerprint is not None
                else "",
                state=result.state,
                sources=tuple(item.locator for item in evidence),
                evidence=evidence,
                diagnostics=result.diagnostics,
            )
        return captured

    def _failed_snapshot(
        self,
        *,
        capability: KeydexCapability,
        descriptor: KeydexLayerDescriptor,
        fingerprint: KeydexCapabilityFingerprint | None,
        diagnostic: KeydexDiagnostic,
    ) -> CapabilityLayerSnapshot:
        evidence = fingerprint.evidence if fingerprint is not None else ()
        return CapabilityLayerSnapshot(
            capability_id=capability.id,
            scope=descriptor.scope,
            payload=None,
            fingerprint=fingerprint.digest() if fingerprint is not None else "",
            available=False,
            state="failed",
            sources=tuple(item.locator for item in evidence),
            evidence=evidence,
            diagnostics=(diagnostic,),
        )

    def _build_fingerprint(
        self,
        scope: KeydexScope,
        root: Path,
    ) -> KeydexLayerFingerprint:
        return build_keydex_layer_fingerprint(scope, root, registry=self.registry)
