from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from datetime import UTC, datetime

from .models import GitCommandRequest, GitConfirmationResponse


class GitConfirmationService:
    def __init__(self, *, secret: bytes | None = None, ttl_seconds: int = 120) -> None:
        self._secret = secret or secrets.token_bytes(32)
        self._ttl_seconds = ttl_seconds

    def issue(
        self,
        command: str,
        request: GitCommandRequest,
        *,
        risk: str,
    ) -> GitConfirmationResponse:
        expires_at = int(time.time()) + self._ttl_seconds
        payload = {
            "command": command,
            "fingerprint": _fingerprint(request),
            "expires_at": expires_at,
        }
        encoded = _encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
        signature = _encode(hmac.new(self._secret, encoded.encode(), hashlib.sha256).digest())
        return GitConfirmationResponse(
            token=f"{encoded}.{signature}",
            expires_at=datetime.fromtimestamp(expires_at, tz=UTC).isoformat(),
            command=command,
            risk=risk,
        )

    def validate(self, token: str, command: str, request: GitCommandRequest) -> bool:
        try:
            encoded, signature = token.split(".", 1)
            expected = _encode(hmac.new(self._secret, encoded.encode(), hashlib.sha256).digest())
            if not hmac.compare_digest(signature, expected):
                return False
            payload = json.loads(_decode(encoded))
            return (
                payload["command"] == command
                and payload["fingerprint"] == _fingerprint(request)
                and int(payload["expires_at"]) >= int(time.time())
            )
        except (ValueError, TypeError, KeyError, json.JSONDecodeError):
            return False


def _fingerprint(request: GitCommandRequest) -> str:
    payload = request.model_dump(mode="json", exclude={"confirmation_token"})
    encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    return hashlib.sha256(encoded).hexdigest()


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
