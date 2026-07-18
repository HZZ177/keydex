from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel

from backend.app.core.exception_handler import register_exception_handlers


class _RequestBody(BaseModel):
    count: int


def _client() -> TestClient:
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/success")
    async def success() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/structured")
    async def structured() -> None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "operation_conflict",
                "message": "操作冲突",
                "details": {"operation_id": "op-1", "api_key": "secret"},
                "retryable": True,
            },
            headers={"X-Error-Source": "test"},
        )

    @app.get("/legacy-text")
    async def legacy_text() -> None:
        raise HTTPException(status_code=404, detail="资源不存在")

    @app.post("/validation")
    async def validation(payload: _RequestBody) -> _RequestBody:
        return payload

    @app.get("/unhandled")
    async def unhandled() -> None:
        raise RuntimeError("internal secret must stay in logs")

    return TestClient(app, raise_server_exceptions=False)


def test_http_exception_wraps_canonical_detail_and_preserves_headers() -> None:
    response = _client().get("/structured")

    assert response.status_code == 409
    assert response.headers["x-error-source"] == "test"
    assert response.json() == {
        "detail": {
            "schema_version": 1,
            "code": "operation_conflict",
            "message": "操作冲突",
            "details": {"operation_id": "op-1", "api_key": "***REDACTED***"},
            "retryable": True,
            "status": 409,
        }
    }


def test_legacy_text_http_exception_is_normalized() -> None:
    response = _client().get("/legacy-text")

    assert response.status_code == 404
    assert response.json()["detail"] == {
        "schema_version": 1,
        "code": "http_error",
        "message": "资源不存在",
        "details": {},
        "retryable": False,
        "status": 404,
    }


def test_validation_error_uses_detail_envelope_without_echoing_input() -> None:
    response = _client().post("/validation", json={"count": "not-a-number"})

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "request_validation_failed"
    assert detail["status"] == 422
    assert detail["details"]["errors"]
    assert "not-a-number" not in response.text


def test_unhandled_error_is_safe_and_keeps_request_correlation() -> None:
    response = _client().get("/unhandled", headers={"X-Request-Id": "request-1"})

    assert response.status_code == 500
    assert response.json() == {
        "detail": {
            "schema_version": 1,
            "code": "internal_server_error",
            "message": "服务内部错误",
            "details": {"request_id": "request-1"},
            "retryable": False,
            "status": 500,
        }
    }
    assert "internal secret" not in response.text


def test_success_response_is_unchanged() -> None:
    response = _client().get("/success")

    assert response.status_code == 200
    assert response.json() == {"ok": True}
