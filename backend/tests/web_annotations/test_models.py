from __future__ import annotations

from copy import deepcopy

import pytest
from pydantic import ValidationError

from backend.app.web_annotations.models import (
    MAX_ANNOTATION_BODY_CHARACTERS,
    WebAnnotationCreateRequest,
    WebAnnotationPatchRequest,
    WebAnnotationResourceRecord,
    WebAnnotationRetargetRequest,
    WebAnnotationSource,
)
from backend.app.web_annotations.url_identity import REDACTED_QUERY_VALUE, normalize_local_file_url


def _frame() -> dict[str, object]:
    return {
        "url": "https://example.com/docs?page=1&token=frame-secret",
        "name": "docs",
        "index_path": [0],
        "parent_element_path": [{"child_index": 2, "shadow_root": False}],
    }


def _text_target() -> dict[str, object]:
    return {
        "type": "text",
        "quote": {"exact": "Selected text", "prefix": "Before ", "suffix": " after"},
        "position": {"start": 10, "end": 23, "text_model_version": 1},
        "dom_range": {
            "start_path": [{"child_index": 0, "shadow_root": False}],
            "start_offset": 1,
            "end_path": [{"child_index": 1, "shadow_root": False}],
            "end_offset": 4,
        },
        "context": {
            "heading_path": ["API", "Parameters"],
            "container_role": "article",
            "container_text_digest": "sha256:context",
        },
        "rects": [{"x": 12, "y": 20, "width": 100, "height": 18}],
        "frame": _frame(),
    }


def _element_target() -> dict[str, object]:
    return {
        "type": "element",
        "tag": "button",
        "role": "button",
        "accessible_name": "Create",
        "text_summary": "Create record",
        "stable_attributes": [
            {"name": "id", "value": "create-button"},
            {"name": "href", "value": "/create?code=secret"},
        ],
        "path": [{"child_index": 3, "shadow_root": False}],
        "shadow_host_path": [{"child_index": 1, "shadow_root": True}],
        "context": {"heading_path": ["Records"]},
        "rect": {"x": 10, "y": 20, "width": 120, "height": 32},
        "frame": _frame(),
    }


def _region_target() -> dict[str, object]:
    return {
        "type": "region",
        "rect": {"x": 20, "y": 30, "width": 200, "height": 100},
        "viewport": {"width": 1280, "height": 720},
        "scroll": {"x": 0, "y": 400},
        "relative_element": {
            "path": [{"child_index": 2, "shadow_root": False}],
            "rect": {"x": 10, "y": 20, "width": 300, "height": 200},
            "tag": "article",
            "role": "article",
            "accessible_name": "Release card",
            "text_summary": "Release notes",
            "stable_attributes": [{"name": "id", "value": "release-card"}],
        },
        "visual": {
            "fingerprint_version": 1,
            "local_digest": "fnv1a32:0123abcd",
            "perceptual_hash": "dhash64:0123456789abcdef",
        },
        "frame": _frame(),
    }


def _create_payload(target: dict[str, object] | None = None) -> dict[str, object]:
    return {
        "scope": {"kind": "session", "id": "ses_123"},
        "source": {
            "url": "https://example.com/docs?page=1&token=source-secret#api",
            "title": " Example Docs ",
            "canonical_url": "https://canonical.example/docs?signature=secret",
        },
        "target": target or _text_target(),
        "body_markdown": "这里的约束需要确认。",
        "tags": [" 待确认 ", "待确认", "P1"],
        "properties": [
            {"key": "priority", "type": "text", "value": "high"},
            {"key": "score", "type": "number", "value": 0.8},
            {"key": "verified", "type": "boolean", "value": False},
            {"key": "due", "type": "date", "value": "2026-07-22"},
            {
                "key": "reference",
                "type": "url",
                "value": "https://example.com/ref?api_key=secret",
            },
        ],
        "staged_asset_ids": [],
    }


@pytest.mark.parametrize("target_factory", [_text_target, _element_target, _region_target])
def test_accepts_strict_discriminated_targets(target_factory) -> None:
    request = WebAnnotationCreateRequest.model_validate(_create_payload(target_factory()))

    assert request.target.type == target_factory()["type"]
    assert request.source.title == "Example Docs"
    assert request.tags == ["待确认", "P1"]
    assert "source-secret" not in request.source.url
    assert REDACTED_QUERY_VALUE in request.source.url
    assert request.source.identity().origin == "https://example.com"
    assert request.source.canonical_url == (
        f"https://canonical.example/docs?signature={REDACTED_QUERY_VALUE}"
    )
    assert REDACTED_QUERY_VALUE in request.target.frame.url
    if request.target.type == "element":
        assert request.target.stable_attributes[1].value == (f"/create?code={REDACTED_QUERY_VALUE}")


def test_canonical_url_never_changes_actual_page_identity() -> None:
    first = WebAnnotationSource.model_validate(
        {
            "url": "https://example.com/docs#api",
            "title": "Docs",
            "canonical_url": "https://other.example/canonical",
        }
    )
    second = WebAnnotationSource.model_validate(
        {
            "url": "https://example.com/docs#api",
            "title": "Docs",
            "canonical_url": "https://example.com/different",
        }
    )

    assert first.identity() == second.identity()
    assert first.canonical_url != second.canonical_url


def test_accepts_local_file_source_with_explicit_versioned_identity() -> None:
    source = WebAnnotationSource.model_validate(
        {
            "source_kind": "local_file",
            "url": "file:///D:/workspace/%E4%B8%AD%E6%96%87%20%E9%A1%B5.html#details",
            "title": "本地页面",
            "canonical_url": "file:///D:/workspace/%E4%B8%AD%E6%96%87%20%E9%A1%B5.html",
            "profile_mode": "persistent",
        }
    )
    identity = source.identity()

    assert source.source_kind == "local_file"
    assert identity.normalization_version == 2
    assert identity.document_url == (
        "file:///D:/workspace/%E4%B8%AD%E6%96%87%20%E9%A1%B5.html"
    )
    assert identity.origin == "file://"


def test_accepts_local_file_frame_stable_attributes_and_url_property() -> None:
    target = _element_target()
    target["frame"]["url"] = "file:///D:/workspace/index.html#details"  # type: ignore[index]
    target["stable_attributes"] = [
        {"name": "href", "value": "../nested/page.html#section"},
        {"name": "src", "value": "file:///D:/workspace/assets/diagram.png"},
    ]
    payload = _create_payload(target)
    payload["source"] = {
        "source_kind": "local_file",
        "url": "file:///D:/workspace/index.html#details",
        "title": "Local page",
        "canonical_url": "file:///D:/workspace/index.html",
        "profile_mode": "persistent",
    }
    payload["properties"] = [
        {
            "key": "reference",
            "type": "url",
            "value": "file:///D:/workspace/nested/page.html#section",
        }
    ]

    request = WebAnnotationCreateRequest.model_validate(payload)

    assert request.target.frame.url == "file:///D:/workspace/index.html#details"
    assert request.target.stable_attributes[0].value == "../nested/page.html#section"
    assert request.target.stable_attributes[1].value == (
        "file:///D:/workspace/assets/diagram.png"
    )
    assert request.properties[0].value == (
        "file:///D:/workspace/nested/page.html#section"
    )


@pytest.mark.parametrize("source_kind", ["web", "local_file"])
def test_accepts_about_blank_frame_for_inherited_source(source_kind: str) -> None:
    payload = _create_payload()
    payload["target"]["frame"]["url"] = "about:blank"  # type: ignore[index]
    if source_kind == "local_file":
        payload["source"] = {
            "source_kind": "local_file",
            "url": "file:///D:/workspace/index.html",
            "title": "Local",
            "profile_mode": "persistent",
        }
        payload["properties"] = [
            {"key": "priority", "type": "text", "value": "high"}
        ]

    request = WebAnnotationCreateRequest.model_validate(payload)

    assert request.target.frame.url == "about:blank"


@pytest.mark.parametrize(
    ("source_kind", "field", "value"),
    [
        ("web", "frame", "file:///D:/workspace/index.html"),
        ("local_file", "frame", "https://example.com/index.html"),
        ("web", "attribute", "file:///D:/workspace/nested.html"),
        ("local_file", "attribute", "https://example.com/nested.html"),
        ("web", "property", "file:///D:/workspace/nested.html"),
        ("local_file", "property", "https://example.com/nested.html"),
    ],
)
def test_rejects_cross_scheme_target_and_property_references(
    source_kind: str,
    field: str,
    value: str,
) -> None:
    target = _element_target()
    payload = _create_payload(target)
    if source_kind == "local_file":
        payload["source"] = {
            "source_kind": "local_file",
            "url": "file:///D:/workspace/index.html",
            "title": "Local",
            "profile_mode": "persistent",
        }
        target["frame"]["url"] = "file:///D:/workspace/index.html"  # type: ignore[index]
    if field == "frame":
        target["frame"]["url"] = value  # type: ignore[index]
    elif field == "attribute":
        target["stable_attributes"] = [{"name": "href", "value": value}]
    else:
        payload["properties"] = [{"key": "reference", "type": "url", "value": value}]

    with pytest.raises(ValidationError, match="scheme does not match"):
        WebAnnotationCreateRequest.model_validate(payload)


@pytest.mark.parametrize(
    ("source_kind", "url"),
    [
        ("web", "file:///D:/workspace/index.html"),
        ("local_file", "https://example.com/docs"),
        ("local_file", "file:///tmp/index.html"),
    ],
)
def test_rejects_source_kind_and_scheme_mismatches(source_kind: str, url: str) -> None:
    with pytest.raises(ValidationError):
        WebAnnotationSource.model_validate(
            {
                "source_kind": source_kind,
                "url": url,
                "title": "Mismatch",
                "profile_mode": "persistent",
            }
        )


def test_validates_local_file_resource_response_identity_fields() -> None:
    identity = normalize_local_file_url("file:///D:/workspace/index.html#details")
    resource = WebAnnotationResourceRecord.model_validate(
        {
            "id": "resource-local",
            "scope": {"kind": "workspace", "id": "ws-1"},
            "source_kind": "local_file",
            "normalization_version": identity.normalization_version,
            "url_key": identity.url_key,
            "url_normalized": identity.url_normalized,
            "document_url": identity.document_url,
            "canonical_url": identity.document_url,
            "origin": identity.origin,
            "title": "Local",
            "created_at": "2026-07-23T00:00:00Z",
            "updated_at": "2026-07-23T00:00:00Z",
        }
    )

    assert resource.source_kind == "local_file"
    assert resource.normalization_version == 2


@pytest.mark.parametrize(
    ("scope", "valid"),
    [
        ({"kind": "session", "id": "ses_1"}, True),
        ({"kind": "workspace", "id": "ws_1"}, True),
        ({"kind": "global", "id": None}, True),
        ({"kind": "session", "id": None}, False),
        ({"kind": "workspace", "id": "  "}, False),
        ({"kind": "global", "id": "unexpected"}, False),
    ],
)
def test_enforces_scope_shape(scope: dict[str, object], valid: bool) -> None:
    payload = _create_payload()
    payload["scope"] = scope
    if valid:
        WebAnnotationCreateRequest.model_validate(payload)
    else:
        with pytest.raises(ValidationError):
            WebAnnotationCreateRequest.model_validate(payload)


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("root",), "unexpected"),
        (("source",), "unexpected"),
        (("target",), "outer_html"),
        (("target", "quote"), "html"),
        (("target", "frame"), "runtime_frame_id"),
    ],
)
def test_rejects_unknown_or_sensitive_shape_fields(path: tuple[str, ...], value: str) -> None:
    payload = _create_payload()
    if path == ("root",):
        payload[value] = "secret"
    else:
        current = payload
        for segment in path:
            current = current[segment]  # type: ignore[index,assignment]
        current[value] = "secret"  # type: ignore[index]

    with pytest.raises(ValidationError):
        WebAnnotationCreateRequest.model_validate(payload)


@pytest.mark.parametrize(
    "forbidden_name",
    ["value", "password", "cookie", "authorization", "data-secret"],
)
def test_rejects_non_whitelisted_element_attributes(forbidden_name: str) -> None:
    target = _element_target()
    target["stable_attributes"] = [{"name": forbidden_name, "value": "secret"}]

    with pytest.raises(ValidationError):
        WebAnnotationCreateRequest.model_validate(_create_payload(target))


def test_rejects_duplicate_element_attributes_and_property_keys() -> None:
    target = _element_target()
    target["stable_attributes"] = [
        {"name": "id", "value": "first"},
        {"name": "id", "value": "second"},
    ]
    with pytest.raises(ValidationError, match="duplicate names"):
        WebAnnotationCreateRequest.model_validate(_create_payload(target))

    payload = _create_payload()
    payload["properties"] = [
        {"key": "Priority", "type": "text", "value": "one"},
        {"key": " priority ", "type": "text", "value": "two"},
    ]
    with pytest.raises(ValidationError, match="duplicate normalized keys"):
        WebAnnotationCreateRequest.model_validate(payload)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda target: target["quote"].update({"exact": ""}),
        lambda target: target["quote"].update({"prefix": "x" * 257}),
        lambda target: target["position"].update({"end": 10}),
        lambda target: target.update({"rects": []}),
        lambda target: target["rects"][0].update({"width": 0}),
    ],
)
def test_rejects_invalid_text_target_bounds(mutation) -> None:
    target = _text_target()
    mutation(target)
    with pytest.raises(ValidationError):
        WebAnnotationCreateRequest.model_validate(_create_payload(target))


@pytest.mark.parametrize(
    "rect",
    [
        {"x": -1, "y": 0, "width": 10, "height": 10},
        {"x": 0, "y": 0, "width": 0, "height": 10},
        {"x": 1200, "y": 0, "width": 100, "height": 10},
        {"x": 0, "y": 700, "width": 10, "height": 30},
    ],
)
def test_rejects_invalid_region_coordinates(rect: dict[str, int]) -> None:
    target = _region_target()
    target["rect"] = rect
    with pytest.raises(ValidationError):
        WebAnnotationCreateRequest.model_validate(_create_payload(target))


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("local_digest", "sha256:not-a-local-digest"),
        ("local_digest", "fnv1a32:ABCDEF12"),
        ("perceptual_hash", "dhash64:short"),
        ("perceptual_hash", "dhash64:0123456789ABCDEf"),
    ],
)
def test_rejects_invalid_region_visual_fingerprints(field: str, value: str) -> None:
    target = _region_target()
    target["visual"][field] = value  # type: ignore[index]

    with pytest.raises(ValidationError):
        WebAnnotationCreateRequest.model_validate(_create_payload(target))


def test_rejects_duplicate_region_anchor_attributes() -> None:
    target = _region_target()
    target["relative_element"]["stable_attributes"] = [  # type: ignore[index]
        {"name": "id", "value": "first"},
        {"name": "id", "value": "second"},
    ]

    with pytest.raises(ValidationError, match="duplicate names"):
        WebAnnotationCreateRequest.model_validate(_create_payload(target))


def test_enforces_body_tag_property_and_id_limits() -> None:
    accepted = _create_payload()
    accepted["body_markdown"] = "界" * MAX_ANNOTATION_BODY_CHARACTERS
    assert len(WebAnnotationCreateRequest.model_validate(accepted).body_markdown) == MAX_ANNOTATION_BODY_CHARACTERS

    payload = _create_payload()
    payload["body_markdown"] = "界" * (MAX_ANNOTATION_BODY_CHARACTERS + 1)
    with pytest.raises(ValidationError, match="body_markdown"):
        WebAnnotationCreateRequest.model_validate(payload)

    payload = _create_payload()
    payload["tags"] = [f"tag-{index}" for index in range(21)]
    with pytest.raises(ValidationError):
        WebAnnotationCreateRequest.model_validate(payload)

    payload = _create_payload()
    payload["properties"] = [
        {"key": f"large-{index}", "type": "text", "value": "x" * 8_192} for index in range(3)
    ]
    with pytest.raises(ValidationError, match="properties cannot exceed"):
        WebAnnotationCreateRequest.model_validate(payload)

    payload = _create_payload()
    payload["staged_asset_ids"] = ["asset:one", "asset:one"]
    with pytest.raises(ValidationError, match="duplicates"):
        WebAnnotationCreateRequest.model_validate(payload)


@pytest.mark.parametrize(
    "property_value",
    [
        {"key": "number", "type": "number", "value": "1"},
        {"key": "number", "type": "number", "value": True},
        {"key": "boolean", "type": "boolean", "value": 1},
        {"key": "date", "type": "date", "value": "2026-02-30"},
        {"key": "url", "type": "url", "value": "file:///secret"},
        {"key": "unknown", "type": "json", "value": {}},
    ],
)
def test_rejects_invalid_typed_property_values(property_value: dict[str, object]) -> None:
    payload = _create_payload()
    payload["properties"] = [property_value]
    with pytest.raises(ValidationError):
        WebAnnotationCreateRequest.model_validate(payload)


def test_patch_and_retarget_requests_are_strict_and_revisioned() -> None:
    patch = WebAnnotationPatchRequest.model_validate(
        {"expected_revision": 2, "tags": [" P1 ", "p1"]}
    )
    assert patch.tags == ["P1"]

    retarget = WebAnnotationRetargetRequest.model_validate(
        {"expected_revision": 2, "target": _region_target()}
    )
    assert retarget.reason == "user_retarget"

    with pytest.raises(ValidationError, match="at least one"):
        WebAnnotationPatchRequest.model_validate({"expected_revision": 2})
    with pytest.raises(ValidationError):
        WebAnnotationRetargetRequest.model_validate(
            {"expected_revision": 2, "target": _region_target(), "reason": "migration"}
        )


def test_models_do_not_mutate_caller_owned_nested_payloads() -> None:
    payload = _create_payload(_element_target())
    original = deepcopy(payload)

    WebAnnotationCreateRequest.model_validate(payload)

    assert payload == original
