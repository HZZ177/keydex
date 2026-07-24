from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.core.data_path import resolve_data_path
from backend.app.main import create_app


def test_upload_local_file_returns_stored_path_without_attachment_record(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    with TestClient(app) as client:
        response = client.post(
            "/api/attachments/local-file?filename=notes.txt&source=pasted",
            content=b"plain text",
            headers={"content-type": "text/plain"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "notes.txt"
    assert body["source"] == "pasted"
    assert body["mime_type"] == "text/plain"
    assert body["size"] == len(b"plain text")
    stored_path = Path(body["path"])
    assert stored_path.exists()
    assert stored_path.read_bytes() == b"plain text"
    assert app.state.repositories.attachments.get(body["id"]) is None


def test_discard_unreferenced_web_annotation_deletes_managed_file_and_record(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    with TestClient(app) as client:
        uploaded = _upload_image(client, source="web_annotation")
        stored_path = resolve_data_path(app.state.settings.data_dir, uploaded["path"])

        response = client.delete(
            f"/api/attachments/{uploaded['attachment_id']}/unreferenced-web-annotation"
        )
        repeated = client.delete(
            f"/api/attachments/{uploaded['attachment_id']}/unreferenced-web-annotation"
        )

    assert response.status_code == 200
    assert response.json() == {"attachment_id": uploaded["attachment_id"], "deleted": True}
    assert repeated.status_code == 200
    assert repeated.json()["deleted"] is False
    assert not stored_path.exists()
    assert not stored_path.parent.exists()
    assert app.state.repositories.attachments.get(uploaded["attachment_id"]) is None


def test_discard_web_annotation_refuses_normal_and_unmanaged_attachments(tmp_path) -> None:
    settings = AppSettings(data_dir=tmp_path / "data")
    app = create_app(settings)
    unmanaged_path = tmp_path / "outside.png"
    unmanaged_path.write_bytes(b"outside")
    unmanaged = app.state.repositories.attachments.create(
        attachment_id="unmanaged-web-annotation",
        user_id=settings.default_user_id,
        type="image",
        source="web_annotation",
        name=unmanaged_path.name,
        path=str(unmanaged_path),
        mime_type="image/png",
        size=unmanaged_path.stat().st_size,
    )
    with TestClient(app) as client:
        normal = _upload_image(client, source="pasted")
        normal_response = client.delete(
            f"/api/attachments/{normal['attachment_id']}/unreferenced-web-annotation"
        )
        unmanaged_response = client.delete(
            f"/api/attachments/{unmanaged.id}/unreferenced-web-annotation"
        )

    assert normal_response.status_code == 409
    assert normal_response.json()["detail"]["code"] == "attachment_discard_source_forbidden"
    assert unmanaged_response.status_code == 409
    assert unmanaged_response.json()["detail"]["code"] == "attachment_discard_unmanaged_path"
    assert unmanaged_path.exists()
    assert app.state.repositories.attachments.get(normal["attachment_id"]) is not None
    assert app.state.repositories.attachments.get(unmanaged.id) is not None


def test_discard_web_annotation_refuses_message_history_reference(tmp_path) -> None:
    settings = AppSettings(data_dir=tmp_path / "data")
    app = create_app(settings)
    repositories = app.state.repositories
    repositories.sessions.create(
        session_id="attachment-history-session",
        user_id=settings.default_user_id,
        scene_id="desktop-agent",
    )
    with TestClient(app) as client:
        uploaded = _upload_image(client, source="web_annotation")
        repositories.message_events.append(
            event_id="attachment-history-event",
            session_id="attachment-history-session",
            turn_index=1,
            action="message.user.created",
            data={"attachments": [{"attachment_id": uploaded["attachment_id"]}]},
        )
        response = client.delete(
            f"/api/attachments/{uploaded['attachment_id']}/unreferenced-web-annotation"
        )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "attachment_discard_referenced"
    assert resolve_data_path(settings.data_dir, uploaded["path"]).exists()
    assert repositories.attachments.get(uploaded["attachment_id"]) is not None


def _upload_image(client: TestClient, *, source: str) -> dict[str, object]:
    response = client.post(
        f"/api/attachments/upload?filename=evidence.png&source={source}",
        content=b"png evidence",
        headers={"content-type": "image/png"},
    )
    assert response.status_code == 200
    return response.json()
