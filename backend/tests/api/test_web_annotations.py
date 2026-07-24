from __future__ import annotations

from copy import deepcopy
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app


def _client(tmp_path) -> TestClient:
    return TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))


def _text_target(*, exact: str = "Selected text", start: int = 10) -> dict:
    return {
        "type": "text",
        "quote": {
            "exact": exact,
            "prefix": "Before ",
            "suffix": " after",
        },
        "position": {
            "start": start,
            "end": start + len(exact),
            "text_model_version": 1,
        },
        "context": {"heading_path": ["API"]},
        "rects": [{"x": 10.0, "y": 20.0, "width": 120.0, "height": 18.0}],
        "frame": {"url": "https://example.com/docs?page=1", "index_path": []},
    }


def _create_payload(scope: dict, *, suffix: str = "one", url: str | None = None) -> dict:
    return {
        "schema_version": 1,
        "scope": scope,
        "source": {
            "url": url or f"https://example.com/docs?page=1#{suffix}",
            "title": "Example Docs",
            "canonical_url": "https://example.com/docs",
            "profile_mode": "persistent",
        },
        "target": _text_target(exact=f"Selected {suffix}"),
        "body_markdown": f"Body {suffix}",
        "tags": ["P1", " p1 ", suffix],
        "properties": [
            {"key": "priority", "type": "text", "value": "high"},
            {"key": "verified", "type": "boolean", "value": False},
        ],
        "staged_asset_ids": [],
    }


def _local_create_payload(
    scope: dict,
    *,
    suffix: str = "one",
    url: str = "file:///D:/wbf-missing-file/index.html#one",
) -> dict:
    payload = _create_payload(scope, suffix=suffix)
    payload["source"] = {
        "source_kind": "local_file",
        "url": url,
        "title": "Missing local fixture",
        "canonical_url": url.split("#", 1)[0],
        "profile_mode": "persistent",
    }
    payload["target"]["frame"]["url"] = url
    return payload


def _create_session(client: TestClient, title: str) -> dict:
    response = client.post("/api/sessions", json={"title": title})
    assert response.status_code == 200
    return response.json()["session"]


def _error_code(response) -> str:
    return response.json()["detail"]["code"]


def test_api_rejects_explicit_source_kind_scheme_mismatches_before_persistence(tmp_path) -> None:
    with _client(tmp_path) as client:
        session = _create_session(client, "Annotation source kind validation")
        scope = {"kind": "session", "id": session["id"]}
        local_with_http = _create_payload(scope, url="https://example.com/docs")
        local_with_http["source"]["source_kind"] = "local_file"
        web_with_file = _create_payload(scope, url="file:///D:/workspace/index.html")
        web_with_file["source"]["source_kind"] = "web"

        local_response = client.post("/api/web-annotations", json=local_with_http)
        web_response = client.post("/api/web-annotations", json=web_with_file)

        assert local_response.status_code == 400
        assert web_response.status_code == 400
        assert _error_code(local_response) == "web_annotation_invalid_url"
        assert _error_code(web_response) == "web_annotation_invalid_url"


def test_list_api_validates_local_file_query_kind_without_reading_disk(tmp_path) -> None:
    with _client(tmp_path) as client:
        response = client.get(
            "/api/web-annotations",
            params={
                "scope_kind": "global",
                "source_kind": "local_file",
                "url": "file:///tmp/not-a-windows-file.html",
            },
        )

        assert response.status_code == 400
        assert _error_code(response) == "web_annotation_invalid_url"


def test_local_file_crud_conflict_retarget_and_delete_never_reads_page(
    tmp_path,
    monkeypatch,
) -> None:
    blocked_path_marker = "wbf-missing-file"
    original_open = Path.open
    original_stat = Path.stat

    def guarded_open(path: Path, *args, **kwargs):
        if blocked_path_marker in str(path).casefold():
            raise AssertionError("local-file annotation identity must not open the page")
        return original_open(path, *args, **kwargs)

    def guarded_stat(path: Path, *args, **kwargs):
        if blocked_path_marker in str(path).casefold():
            raise AssertionError("local-file annotation identity must not stat the page")
        return original_stat(path, *args, **kwargs)

    with _client(tmp_path) as client:
        monkeypatch.setattr(Path, "open", guarded_open)
        monkeypatch.setattr(Path, "stat", guarded_stat)
        session = _create_session(client, "Local annotation CRUD")
        scope = {"kind": "session", "id": session["id"]}
        created = client.post("/api/web-annotations", json=_local_create_payload(scope))

        assert created.status_code == 201
        detail = created.json()
        annotation_id = detail["annotation"]["id"]
        assert detail["resource"]["source_kind"] == "local_file"
        assert detail["resource"]["normalization_version"] == 2
        assert detail["resource"]["url_normalized"].startswith(
            "file:///D:/wbf-missing-file/index.html"
        )

        exact = client.get(
            "/api/web-annotations",
            params={
                "scope_kind": "session",
                "scope_id": session["id"],
                "source_kind": "local_file",
                "url": "file:///d:/WBF-MISSING-FILE/index.html#one",
            },
        )
        loaded = client.get(f"/api/web-annotations/{annotation_id}")
        patched = client.patch(
            f"/api/web-annotations/{annotation_id}",
            json={
                "schema_version": 1,
                "expected_revision": 1,
                "body_markdown": "Local update",
            },
        )
        stale = client.patch(
            f"/api/web-annotations/{annotation_id}",
            json={
                "schema_version": 1,
                "expected_revision": 1,
                "body_markdown": "Must lose",
            },
        )
        retargeted = client.put(
            f"/api/web-annotations/{annotation_id}/target",
            json={
                "schema_version": 1,
                "expected_revision": 2,
                "target": {
                    **_text_target(exact="Local replacement", start=40),
                    "frame": {
                        "url": "file:///D:/wbf-missing-file/index.html#one",
                        "index_path": [],
                    },
                },
                "reason": "user_retarget",
            },
        )
        deleted = client.delete(f"/api/web-annotations/{annotation_id}")
        missing = client.get(f"/api/web-annotations/{annotation_id}")

    assert exact.status_code == 200
    assert [item["annotation"]["id"] for item in exact.json()["items"]] == [annotation_id]
    assert loaded.status_code == 200
    assert patched.status_code == 200
    assert patched.json()["annotation"]["body_markdown"] == "Local update"
    assert stale.status_code == 409
    assert _error_code(stale) == "web_annotation_revision_conflict"
    assert retargeted.status_code == 200
    assert retargeted.json()["annotation"]["revision"] == 3
    assert len(retargeted.json()["target_history"]) == 1
    assert deleted.status_code == 204
    assert missing.status_code == 404


def test_local_file_document_query_groups_fragments_and_excludes_web(tmp_path) -> None:
    scope = {"kind": "global", "id": None}
    with _client(tmp_path) as client:
        local_ids = []
        for suffix in ("one", "two"):
            response = client.post(
                "/api/web-annotations",
                json=_local_create_payload(
                    scope,
                    suffix=suffix,
                    url=f"file:///D:/wbf-missing-file/index.html#{suffix}",
                ),
            )
            assert response.status_code == 201
            local_ids.append(response.json()["annotation"]["id"])
        web = client.post("/api/web-annotations", json=_create_payload(scope, suffix="web"))
        listed = client.get(
            "/api/web-annotations",
            params={
                "scope_kind": "global",
                "source_kind": "local_file",
                "document_url": "D:\\wbf-missing-file\\index.html",
            },
        )

    assert web.status_code == 201
    assert listed.status_code == 200
    assert {item["annotation"]["id"] for item in listed.json()["items"]} == set(local_ids)
    assert {
        item["resource"]["source_kind"] for item in listed.json()["items"]
    } == {"local_file"}


def test_local_file_patch_and_retarget_use_persisted_source_kind(tmp_path) -> None:
    scope = {"kind": "global", "id": None}
    with _client(tmp_path) as client:
        created = client.post(
            "/api/web-annotations",
            json=_local_create_payload(scope),
        )
        assert created.status_code == 201
        annotation_id = created.json()["annotation"]["id"]
        accepted_property = client.patch(
            f"/api/web-annotations/{annotation_id}",
            json={
                "schema_version": 1,
                "expected_revision": 1,
                "properties": [
                    {
                        "key": "reference",
                        "type": "url",
                        "value": "file:///D:/wbf-missing-file/related.html",
                    }
                ],
            },
        )
        rejected_property = client.patch(
            f"/api/web-annotations/{annotation_id}",
            json={
                "schema_version": 1,
                "expected_revision": 2,
                "properties": [
                    {
                        "key": "reference",
                        "type": "url",
                        "value": "https://example.com/remote",
                    }
                ],
            },
        )
        rejected_target = client.put(
            f"/api/web-annotations/{annotation_id}/target",
            json={
                "schema_version": 1,
                "expected_revision": 2,
                "target": _text_target(exact="Wrong scheme", start=30),
            },
        )
        loaded = client.get(f"/api/web-annotations/{annotation_id}")

    assert accepted_property.status_code == 200
    assert accepted_property.json()["annotation"]["revision"] == 2
    assert rejected_property.status_code == 400
    assert _error_code(rejected_property) == "web_annotation_request_invalid"
    assert rejected_target.status_code == 400
    assert _error_code(rejected_target) == "web_annotation_target_invalid"
    assert loaded.status_code == 200
    assert loaded.json()["annotation"]["revision"] == 2
    assert loaded.json()["target_history"] == []


def test_local_file_identity_is_isolated_across_all_scopes(tmp_path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    with _client(tmp_path) as client:
        session = _create_session(client, "Local annotation session scope")
        workspace_response = client.post(
            "/api/workspaces",
            json={"root_path": str(project), "name": "Local annotation workspace"},
        )
        assert workspace_response.status_code == 200
        workspace = workspace_response.json()["workspace"]
        scopes = (
            {"kind": "session", "id": session["id"]},
            {"kind": "workspace", "id": workspace["id"]},
            {"kind": "global", "id": None},
        )
        created_ids: list[str] = []
        for index, scope in enumerate(scopes):
            response = client.post(
                "/api/web-annotations",
                json=_local_create_payload(scope, suffix=f"scope-{index}"),
            )
            assert response.status_code == 201
            created_ids.append(response.json()["annotation"]["id"])

        listed_ids = []
        for scope in scopes:
            params = {
                "scope_kind": scope["kind"],
                "source_kind": "local_file",
                "url": "file:///D:/wbf-missing-file/index.html#one",
            }
            if scope["id"] is not None:
                params["scope_id"] = scope["id"]
            response = client.get(
                "/api/web-annotations",
                params=params,
            )
            assert response.status_code == 200
            listed_ids.append(response.json()["items"][0]["annotation"]["id"])

    assert listed_ids == created_ids


def test_web_annotation_crud_revision_retarget_and_history(tmp_path) -> None:
    with _client(tmp_path) as client:
        session = _create_session(client, "Annotation CRUD")
        scope = {"kind": "session", "id": session["id"]}
        created = client.post("/api/web-annotations", json=_create_payload(scope))

        assert created.status_code == 201
        detail = created.json()
        annotation_id = detail["annotation"]["id"]
        assert detail["annotation"]["revision"] == 1
        assert detail["annotation"]["tags"] == ["P1", "one"]
        assert detail["resource"]["scope"] == scope

        loaded = client.get(f"/api/web-annotations/{annotation_id}")
        patched = client.patch(
            f"/api/web-annotations/{annotation_id}",
            headers={"If-Match": 'W/"1"'},
            json={
                "schema_version": 1,
                "expected_revision": 1,
                "body_markdown": "Updated body",
                "tags": ["updated"],
            },
        )
        stale = client.patch(
            f"/api/web-annotations/{annotation_id}",
            json={
                "schema_version": 1,
                "expected_revision": 1,
                "body_markdown": "Must not win",
            },
        )
        new_target = _text_target(exact="Replacement", start=30)
        retargeted = client.put(
            f"/api/web-annotations/{annotation_id}/target",
            headers={"If-Match": "2"},
            json={
                "schema_version": 1,
                "expected_revision": 2,
                "target": new_target,
                "reason": "user_retarget",
            },
        )

        assert loaded.status_code == 200
        assert patched.status_code == 200
        assert patched.json()["annotation"]["revision"] == 2
        assert patched.json()["annotation"]["body_markdown"] == "Updated body"
        assert stale.status_code == 409
        assert _error_code(stale) == "web_annotation_revision_conflict"
        current = stale.json()["detail"]["details"]["current"]
        assert current["annotation"]["revision"] == 2
        assert current["annotation"]["body_markdown"] == "Updated body"
        assert retargeted.status_code == 200
        assert retargeted.json()["annotation"]["revision"] == 3
        assert retargeted.json()["annotation"]["target"]["quote"]["exact"] == "Replacement"
        assert retargeted.json()["annotation"]["target"]["position"] == new_target["position"]
        assert len(retargeted.json()["target_history"]) == 1
        prior = retargeted.json()["target_history"][0]
        assert prior["prior_revision"] == 2
        assert prior["target"] == detail["annotation"]["target"]

        deleted = client.delete(f"/api/web-annotations/{annotation_id}")
        missing = client.get(f"/api/web-annotations/{annotation_id}")
        session_after_delete = client.get(f"/api/sessions/{session['id']}")

    assert deleted.status_code == 204
    assert missing.status_code == 404
    assert _error_code(missing) == "web_annotation_not_found"
    assert session_after_delete.status_code == 200


def test_web_annotation_scope_identity_document_query_and_pagination(tmp_path) -> None:
    with _client(tmp_path) as client:
        first_session = _create_session(client, "Scope one")
        second_session = _create_session(client, "Scope two")
        first_scope = {"kind": "session", "id": first_session["id"]}
        second_scope = {"kind": "session", "id": second_session["id"]}

        first_ids = []
        for suffix in ("a", "b", "c"):
            response = client.post(
                "/api/web-annotations",
                json=_create_payload(
                    first_scope,
                    suffix=suffix,
                    url=f"https://example.com/docs?page=1#{suffix}",
                ),
            )
            assert response.status_code == 201
            first_ids.append(response.json()["annotation"]["id"])
        other = client.post(
            "/api/web-annotations",
            json=_create_payload(
                second_scope,
                suffix="other",
                url="https://example.com/docs?page=1#a",
            ),
        )
        assert other.status_code == 201

        exact = client.get(
            "/api/web-annotations",
            params={
                "scope_kind": "session",
                "scope_id": first_session["id"],
                "url": "HTTPS://EXAMPLE.COM:443/docs?page=1#a",
            },
        )
        page_one = client.get(
            "/api/web-annotations",
            params={
                "scope_kind": "session",
                "scope_id": first_session["id"],
                "document_url": "https://example.com/docs?page=1",
                "limit": 2,
            },
        )
        page_two = client.get(
            "/api/web-annotations",
            params={
                "scope_kind": "session",
                "scope_id": first_session["id"],
                "document_url": "https://example.com/docs?page=1",
                "limit": 2,
                "cursor": page_one.json()["next_cursor"],
            },
        )
        other_scope = client.get(
            "/api/web-annotations",
            params={
                "scope_kind": "session",
                "scope_id": second_session["id"],
                "document_url": "https://example.com/docs?page=1",
            },
        )

    assert exact.status_code == 200
    assert len(exact.json()["items"]) == 1
    assert exact.json()["items"][0]["annotation"]["id"] == first_ids[0]
    assert page_one.status_code == 200
    assert len(page_one.json()["items"]) == 2
    assert page_one.json()["next_cursor"]
    assert page_two.status_code == 200
    assert page_two.json()["next_cursor"] is None
    paged_ids = {
        item["annotation"]["id"] for item in page_one.json()["items"] + page_two.json()["items"]
    }
    assert paged_ids == set(first_ids)
    assert len(other_scope.json()["items"]) == 1
    assert other_scope.json()["items"][0]["annotation"]["id"] == other.json()["annotation"]["id"]


def test_web_annotation_api_rejects_forbidden_invalid_and_oversized_requests(tmp_path) -> None:
    missing_scope = {"kind": "session", "id": "missing-session"}
    valid_scope = {"kind": "global", "id": None}
    with _client(tmp_path) as client:
        forbidden = client.post(
            "/api/web-annotations",
            json=_create_payload(missing_scope),
        )
        not_found = client.get("/api/web-annotations/missing")

        incognito_payload = _create_payload(valid_scope)
        incognito_payload["source"]["profile_mode"] = "incognito"
        incognito = client.post("/api/web-annotations", json=incognito_payload)

        invalid_url_payload = _create_payload(valid_scope)
        invalid_url_payload["source"]["url"] = "file:///C:/secrets.txt"
        invalid_url = client.post("/api/web-annotations", json=invalid_url_payload)

        invalid_target_payload = _create_payload(valid_scope)
        invalid_target_payload["target"]["input_value"] = "secret"
        invalid_target = client.post("/api/web-annotations", json=invalid_target_payload)

        oversized_payload = _create_payload(valid_scope)
        oversized_payload["body_markdown"] = "x" * (32 * 1024 + 1)
        oversized = client.post("/api/web-annotations", json=oversized_payload)

        unsupported_payload = _create_payload(valid_scope)
        unsupported_payload["schema_version"] = 2
        unsupported = client.post("/api/web-annotations", json=unsupported_payload)

        created = client.post("/api/web-annotations", json=_create_payload(valid_scope))
        annotation_id = created.json()["annotation"]["id"]
        mismatched_if_match = client.patch(
            f"/api/web-annotations/{annotation_id}",
            headers={"If-Match": "2"},
            json={
                "schema_version": 1,
                "expected_revision": 1,
                "body_markdown": "No update",
            },
        )
        invalid_cursor = client.get(
            "/api/web-annotations",
            params={
                "scope_kind": "global",
                "document_url": "https://example.com/docs",
                "cursor": "not-a-cursor",
            },
        )
        ambiguous_list = client.get(
            "/api/web-annotations",
            params={
                "scope_kind": "global",
                "url": "https://example.com/docs",
                "document_url": "https://example.com/docs",
            },
        )

    assert forbidden.status_code == 403
    assert _error_code(forbidden) == "web_annotation_scope_forbidden"
    assert not_found.status_code == 404
    assert _error_code(not_found) == "web_annotation_not_found"
    assert incognito.status_code == 409
    assert _error_code(incognito) == "web_annotation_incognito_persistence_forbidden"
    assert invalid_url.status_code == 400
    assert _error_code(invalid_url) == "web_annotation_invalid_url"
    assert invalid_target.status_code == 400
    assert _error_code(invalid_target) == "web_annotation_target_invalid"
    assert oversized.status_code == 413
    assert _error_code(oversized) == "web_annotation_payload_too_large"
    assert unsupported.status_code == 422
    assert _error_code(unsupported) == "web_annotation_schema_unsupported"
    assert mismatched_if_match.status_code == 400
    assert _error_code(mismatched_if_match) == "web_annotation_request_invalid"
    assert invalid_cursor.status_code == 400
    assert _error_code(invalid_cursor) == "web_annotation_request_invalid"
    assert ambiguous_list.status_code == 400
    assert _error_code(ambiguous_list) == "web_annotation_request_invalid"


def test_failed_retarget_does_not_write_target_history(tmp_path) -> None:
    scope = {"kind": "global", "id": None}
    with _client(tmp_path) as client:
        created = client.post("/api/web-annotations", json=_create_payload(scope))
        annotation_id = created.json()["annotation"]["id"]
        payload = {
            "schema_version": 1,
            "expected_revision": 2,
            "target": _text_target(exact="Stale replacement", start=30),
        }
        stale = client.put(f"/api/web-annotations/{annotation_id}/target", json=payload)
        loaded = client.get(f"/api/web-annotations/{annotation_id}")

    assert stale.status_code == 409
    assert loaded.json()["annotation"]["revision"] == 1
    assert loaded.json()["target_history"] == []
    assert loaded.json()["annotation"]["target"] == deepcopy(created.json()["annotation"]["target"])
