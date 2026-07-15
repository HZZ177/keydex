from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from typing import Any

import pytest
from watchfiles import Change

from backend.app.services.file_change_hub import (
    IGNORED_WORKSPACE_DIRECTORIES,
    MAX_BATCH_PATHS,
    FileChange,
    FileChangeHub,
    coalesce_file_changes,
    normalize_workspace_change_path,
    should_ignore_workspace_path,
)


class RecordingSubscriber:
    def __init__(self, *, succeeds: bool = True) -> None:
        self.succeeds = succeeds
        self.events: list[tuple[str, dict[str, Any]]] = []

    async def send(
        self,
        *,
        session_id: str,
        action: str,
        data: dict[str, Any],
    ) -> bool:
        self.events.append((action, data))
        return self.succeeds


class ControlledWatchFactory:
    def __init__(self) -> None:
        self.calls: list[Path] = []
        self.started = asyncio.Event()
        self.stopped = asyncio.Event()

    def __call__(self, root: Path, stop_event: asyncio.Event):
        async def stream():
            self.calls.append(root)
            self.started.set()
            try:
                await stop_event.wait()
            finally:
                self.stopped.set()
            if False:
                yield set()

        return stream()


def test_normalizes_workspace_change_path(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    target = root / "src" / "main.py"
    root.mkdir()

    assert normalize_workspace_change_path(root, target) == "src/main.py"
    assert normalize_workspace_change_path(root, Path("src") / "." / "main.py") == (
        "src/main.py"
    )


@pytest.mark.parametrize("outside_name", ["sibling/file.txt", "../escape.txt"])
def test_rejects_change_path_outside_workspace_root(
    tmp_path: Path,
    outside_name: str,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    outside = tmp_path / outside_name

    with pytest.raises(ValueError, match="不在工作区"):
        normalize_workspace_change_path(root, outside)


def test_compares_windows_change_paths_case_insensitively(tmp_path: Path) -> None:
    root = tmp_path / "CaseRoot"
    target = root / "Src" / "Main.py"

    assert normalize_workspace_change_path(
        str(root).upper(),
        str(target).lower(),
        windows_semantics=True,
    ).casefold() == "src/main.py"


@pytest.mark.parametrize("ignored", sorted(IGNORED_WORKSPACE_DIRECTORIES))
def test_ignores_high_noise_workspace_directories(ignored: str) -> None:
    assert should_ignore_workspace_path(f"{ignored}/file.txt")
    assert should_ignore_workspace_path(f"src/{ignored}/nested/file.txt")
    assert not should_ignore_workspace_path(".ordinary-hidden/file.txt")


@pytest.mark.parametrize(
    ("name", "ignored"),
    [
        ("draft.md~", True),
        ("draft.md.swp", True),
        ("draft.tmp", True),
        ("download.crdownload", True),
        (".#draft.md", True),
        ("~$draft.docx", True),
        ("draft.tmp.md", False),
        (".hidden.md", False),
    ],
)
def test_ignores_common_temporary_file_patterns(name: str, ignored: bool) -> None:
    assert should_ignore_workspace_path(name) is ignored


def test_coalesces_add_then_modify_as_added() -> None:
    batch = coalesce_file_changes(
        [FileChange("added", "a.txt"), FileChange("modified", "a.txt")]
    )

    assert batch.changes == (FileChange("added", "a.txt"),)


def test_coalesces_add_then_delete_as_no_change() -> None:
    batch = coalesce_file_changes(
        [FileChange("added", "a.txt"), FileChange("deleted", "a.txt")]
    )

    assert batch.changes == ()
    assert batch.resync_required is False


def test_coalesces_modify_then_delete_as_deleted() -> None:
    batch = coalesce_file_changes(
        [FileChange("modified", "a.txt"), FileChange("deleted", "a.txt")]
    )

    assert batch.changes == (FileChange("deleted", "a.txt"),)


@pytest.mark.asyncio
async def test_restore_operation_publication_is_immediate_and_deduplicated(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    hub = FileChangeHub(start_tasks=False)
    subscriber = RecordingSubscriber()
    await hub.subscribe_workspace("workspace-1", root, subscriber)

    first = await hub.publish_operation_changes(
        "workspace-1",
        "operation-1",
        [FileChange("modified", "src/main.py")],
    )
    replay = await hub.publish_operation_changes(
        "workspace-1",
        "operation-1",
        [FileChange("modified", "src/main.py")],
    )

    assert first is True
    assert replay is False
    assert subscriber.events == [
        (
            "workspaceFilesChanged",
            {
                "workspace_id": "workspace-1",
                "sequence": 1,
                "resync_required": False,
                "changes": [{"kind": "modified", "path": "src/main.py"}],
            },
        )
    ]
    await hub.close()


def test_coalesces_delete_then_add_as_modified() -> None:
    batch = coalesce_file_changes(
        [FileChange("deleted", "a.txt"), FileChange("added", "a.txt")]
    )

    assert batch.changes == (FileChange("modified", "a.txt"),)


@pytest.mark.parametrize("count", [2, 20])
def test_coalesces_repeated_modify_as_single_change(count: int) -> None:
    batch = coalesce_file_changes([FileChange("modified", "a.txt")] * count)

    assert batch.changes == (FileChange("modified", "a.txt"),)


def test_marks_batch_resync_when_change_limit_overflows() -> None:
    boundary = coalesce_file_changes(
        [FileChange("modified", f"{index}.txt") for index in range(MAX_BATCH_PATHS)]
    )
    overflow = coalesce_file_changes(
        [FileChange("modified", f"{index}.txt") for index in range(MAX_BATCH_PATHS + 1)]
    )

    assert len(boundary.changes) == MAX_BATCH_PATHS
    assert boundary.resync_required is False
    assert overflow == type(overflow)(resync_required=True)


@pytest.mark.asyncio
async def test_starts_root_watcher_for_first_subscriber(tmp_path: Path) -> None:
    factory = ControlledWatchFactory()
    hub = FileChangeHub(watch_factory=factory)

    await hub.subscribe_workspace("workspace-1", tmp_path, RecordingSubscriber())
    await asyncio.wait_for(factory.started.wait(), timeout=1)

    assert factory.calls == [tmp_path.resolve()]
    await hub.close()


@pytest.mark.asyncio
async def test_stops_root_watcher_after_last_subscriber_leaves(tmp_path: Path) -> None:
    factory = ControlledWatchFactory()
    hub = FileChangeHub(watch_factory=factory)
    first = RecordingSubscriber()
    second = RecordingSubscriber()
    await hub.subscribe_workspace("workspace-1", tmp_path, first)
    await hub.subscribe_workspace("workspace-1", tmp_path, second)
    await asyncio.wait_for(factory.started.wait(), timeout=1)

    await hub.unsubscribe_workspace("workspace-1", first)
    assert not factory.stopped.is_set()
    await hub.unsubscribe_workspace("workspace-1", second)

    await asyncio.wait_for(factory.stopped.wait(), timeout=1)
    assert hub._roots == {}


@pytest.mark.asyncio
async def test_reuses_single_watcher_for_same_normalized_root(tmp_path: Path) -> None:
    factory = ControlledWatchFactory()
    hub = FileChangeHub(watch_factory=factory)
    await hub.subscribe_workspace("workspace-1", tmp_path, RecordingSubscriber())
    await hub.subscribe_workspace("workspace-2", tmp_path / ".", RecordingSubscriber())
    await asyncio.wait_for(factory.started.wait(), timeout=1)

    assert len(factory.calls) == 1
    assert len(hub._roots) == 1
    await hub.close()


@pytest.mark.asyncio
async def test_isolates_watchers_and_events_between_roots(tmp_path: Path) -> None:
    root_a = tmp_path / "a"
    root_b = tmp_path / "b"
    root_a.mkdir()
    root_b.mkdir()
    subscriber_a = RecordingSubscriber()
    subscriber_b = RecordingSubscriber()
    hub = FileChangeHub(start_tasks=False)
    await hub.subscribe_workspace("workspace-a", root_a, subscriber_a)
    await hub.subscribe_workspace("workspace-b", root_b, subscriber_b)

    await hub.handle_raw_changes(root_a, {(Change.modified, root_a / "file.txt")})

    assert [event[0] for event in subscriber_a.events] == ["workspaceFilesChanged"]
    assert subscriber_b.events == []
    assert len(hub._roots) == 2
    await hub.close()


@pytest.mark.asyncio
async def test_t57_workspace_tree_and_preview_watchers_keep_modify_delete_contract(
    tmp_path: Path,
) -> None:
    target = _make_file(tmp_path / "docs" / "guide.md")
    workspace_subscriber = RecordingSubscriber()
    preview_subscriber = RecordingSubscriber()
    hub = FileChangeHub(start_tasks=False)
    await hub.subscribe_workspace("workspace-1", tmp_path, workspace_subscriber)
    await hub.subscribe_local_file("preview-1", target, preview_subscriber)

    await hub.handle_raw_changes(tmp_path, {(Change.modified, target)})
    await hub.handle_raw_changes(target.parent, {(Change.modified, target)})
    target.unlink()
    await hub.handle_raw_changes(tmp_path, {(Change.deleted, target)})
    await hub.handle_raw_changes(target.parent, {(Change.deleted, target)})

    assert [event[0] for event in workspace_subscriber.events] == [
        "workspaceFilesChanged",
        "workspaceFilesChanged",
    ]
    assert [event[1]["sequence"] for event in workspace_subscriber.events] == [1, 2]
    assert [event[1]["changes"] for event in workspace_subscriber.events] == [
        [{"kind": "modified", "path": "docs/guide.md"}],
        [{"kind": "deleted", "path": "docs/guide.md"}],
    ]
    assert [event[0] for event in preview_subscriber.events] == [
        "localFileChanged",
        "localFileChanged",
    ]
    assert [event[1]["changes"] for event in preview_subscriber.events] == [
        [{"kind": "modified", "path": str(target.resolve())}],
        [{"kind": "deleted", "path": str(target.resolve())}],
    ]
    await hub.close()


@pytest.mark.asyncio
async def test_removes_subscriber_when_event_send_fails(tmp_path: Path) -> None:
    failing = RecordingSubscriber(succeeds=False)
    healthy = RecordingSubscriber()
    hub = FileChangeHub(start_tasks=False)
    await hub.subscribe_workspace("workspace-1", tmp_path, failing)
    await hub.subscribe_workspace("workspace-1", tmp_path, healthy)

    await hub.handle_raw_changes(tmp_path, {(Change.modified, tmp_path / "file.txt")})

    assert len(healthy.events) == 1
    assert failing not in hub._workspace_subscribers["workspace-1"]
    await hub.close()


@pytest.mark.asyncio
async def test_broadcasts_resync_when_root_watcher_raises(tmp_path: Path) -> None:
    started = asyncio.Event()

    def failing_factory(_root: Path, _stop_event: asyncio.Event):
        async def stream():
            started.set()
            raise RuntimeError("watch failed")
            if False:
                yield set()

        return stream()

    subscriber = RecordingSubscriber()
    hub = FileChangeHub(watch_factory=failing_factory)
    await hub.subscribe_workspace("workspace-1", tmp_path, subscriber)
    await asyncio.wait_for(started.wait(), timeout=1)
    for _ in range(10):
        if subscriber.events:
            break
        await asyncio.sleep(0)

    assert subscriber.events[0][0] == "workspaceFilesChanged"
    assert subscriber.events[0][1]["resync_required"] is True
    assert subscriber.events[0][1]["changes"] == []
    await hub.close()


@pytest.mark.asyncio
async def test_close_cancels_all_watchers_and_clears_subscriptions(tmp_path: Path) -> None:
    root_b = tmp_path / "b"
    root_b.mkdir()
    factory = ControlledWatchFactory()
    hub = FileChangeHub(watch_factory=factory)
    subscriber = RecordingSubscriber()
    await hub.subscribe_workspace("workspace-1", tmp_path, subscriber)
    await hub.subscribe_workspace("workspace-2", root_b, subscriber)
    await hub.subscribe_local_file("local-1", _make_file(tmp_path / "local.md"), subscriber)

    await hub.close()
    await hub.close()

    assert hub._roots == {}
    assert hub._workspace_subscribers == {}
    assert hub._local_subscriptions == {}


@pytest.mark.asyncio
async def test_local_file_watch_filters_sibling_changes(tmp_path: Path) -> None:
    target = _make_file(tmp_path / "target.md")
    sibling = _make_file(tmp_path / "sibling.md")
    subscriber = RecordingSubscriber()
    hub = FileChangeHub(start_tasks=False)
    await hub.subscribe_local_file("local-1", target, subscriber)

    await hub.handle_raw_changes(tmp_path, {(Change.modified, sibling)})
    assert subscriber.events == []
    await hub.handle_raw_changes(tmp_path, {(Change.modified, target)})

    assert subscriber.events[0][0] == "localFileChanged"
    assert subscriber.events[0][1]["changes"] == [
        {"kind": "modified", "path": str(target.resolve())}
    ]
    await hub.close()


@pytest.mark.asyncio
async def test_local_file_watch_coalesces_atomic_replace(tmp_path: Path) -> None:
    target = _make_file(tmp_path / "target.md")
    subscriber = RecordingSubscriber()
    hub = FileChangeHub(start_tasks=False)
    await hub.subscribe_local_file("local-1", target, subscriber)

    await hub.handle_raw_changes(
        tmp_path,
        {(Change.deleted, target), (Change.added, target)},
    )

    assert subscriber.events[0][1]["changes"] == [
        {"kind": "modified", "path": str(target.resolve())}
    ]
    await hub.close()


@pytest.mark.asyncio
async def test_document_write_echo_is_tagged_for_workspace_and_local_subscribers(
    tmp_path: Path,
) -> None:
    target = _make_file(tmp_path / "target.md", "after")
    subscriber = RecordingSubscriber()
    hub = FileChangeHub(start_tasks=False)
    await hub.subscribe_workspace("workspace-1", tmp_path, subscriber)
    await hub.subscribe_local_file("local-1", target, subscriber)
    await hub.register_document_write_echo(
        "write-1",
        target,
        revision=_revision(b"after"),
        total_bytes=len(b"after"),
    )

    await hub.handle_raw_changes(
        tmp_path,
        {(Change.deleted, target), (Change.added, target)},
    )

    assert [event[0] for event in subscriber.events] == [
        "workspaceFilesChanged",
        "localFileChanged",
    ]
    for _, payload in subscriber.events:
        assert payload["changes"] == [
            {
                "kind": "modified",
                "path": "target.md" if "workspace_id" in payload else str(target.resolve()),
                "write_id": "write-1",
            }
        ]
    await hub.close()


@pytest.mark.asyncio
async def test_document_write_echo_is_not_tagged_after_an_external_rewrite(tmp_path: Path) -> None:
    target = _make_file(tmp_path / "target.md", "after")
    subscriber = RecordingSubscriber()
    hub = FileChangeHub(start_tasks=False)
    await hub.subscribe_workspace("workspace-1", tmp_path, subscriber)
    await hub.register_document_write_echo(
        "write-1",
        target,
        revision=_revision(b"after"),
        total_bytes=len(b"after"),
    )
    target.write_text("external", encoding="utf-8")

    await hub.handle_raw_changes(tmp_path, {(Change.modified, target)})

    assert subscriber.events[0][1]["changes"] == [
        {"kind": "modified", "path": "target.md"}
    ]
    await hub.close()


@pytest.mark.asyncio
async def test_document_write_echo_tags_atomic_replace_parent_directory_event(
    tmp_path: Path,
) -> None:
    target = _make_file(tmp_path / ".ktaicoding" / "des" / "target.md", "after")
    temporary = target.parent / ".target.md.keydex-test.tmp"
    subscriber = RecordingSubscriber()
    hub = FileChangeHub(start_tasks=False)
    await hub.subscribe_workspace("workspace-1", tmp_path, subscriber)
    await hub.register_document_write_echo(
        "write-1",
        target,
        revision=_revision(b"after"),
        total_bytes=len(b"after"),
    )

    await hub.handle_raw_changes(
        tmp_path,
        {
            (Change.deleted, temporary),
            (Change.modified, target.parent),
            (Change.added, temporary),
            (Change.deleted, target),
            (Change.added, target),
        },
    )

    assert subscriber.events[0][1]["changes"] == [
        {"kind": "modified", "path": ".ktaicoding/des", "write_id": "write-1"},
        {
            "kind": "modified",
            "path": ".ktaicoding/des/target.md",
            "write_id": "write-1",
        },
    ]
    await hub.close()


@pytest.mark.asyncio
async def test_failed_document_write_discards_registered_echo(tmp_path: Path) -> None:
    target = _make_file(tmp_path / "target.md", "external")
    subscriber = RecordingSubscriber()
    hub = FileChangeHub(start_tasks=False)
    await hub.subscribe_workspace("workspace-1", tmp_path, subscriber)
    await hub.register_document_write_echo(
        "write-1",
        target,
        revision=_revision(b"planned"),
        total_bytes=len(b"planned"),
    )

    await hub.discard_document_write_echo("write-1", target)
    await hub.handle_raw_changes(tmp_path, {(Change.modified, target)})

    assert subscriber.events[0][1]["changes"] == [
        {"kind": "modified", "path": "target.md"}
    ]
    await hub.close()


@pytest.mark.asyncio
async def test_explicit_local_file_watch_bypasses_workspace_ignore(tmp_path: Path) -> None:
    ignored_root = tmp_path / ".git"
    ignored_root.mkdir()
    target = _make_file(ignored_root / "config")
    workspace_subscriber = RecordingSubscriber()
    local_subscriber = RecordingSubscriber()
    hub = FileChangeHub(start_tasks=False)
    await hub.subscribe_workspace("workspace-1", tmp_path, workspace_subscriber)
    await hub.subscribe_local_file("local-1", target, local_subscriber)

    await hub.handle_raw_changes(tmp_path, {(Change.modified, target)})
    await hub.handle_raw_changes(ignored_root, {(Change.modified, target)})

    assert workspace_subscriber.events == []
    assert local_subscriber.events[0][0] == "localFileChanged"
    await hub.close()


@pytest.mark.asyncio
async def test_workspace_event_sequence_is_monotonic_for_all_subscribers(
    tmp_path: Path,
) -> None:
    first = RecordingSubscriber()
    second = RecordingSubscriber()
    hub = FileChangeHub(start_tasks=False)
    await hub.subscribe_workspace("workspace-1", tmp_path, first)
    await hub.subscribe_workspace("workspace-1", tmp_path, second)

    await hub.handle_raw_changes(tmp_path, {(Change.added, tmp_path / "a.txt")})
    await hub.handle_raw_changes(tmp_path, {(Change.modified, tmp_path / "a.txt")})

    for subscriber in (first, second):
        assert [event[1]["sequence"] for event in subscriber.events] == [1, 2]
        assert subscriber.events == (
            first.events if subscriber is second else subscriber.events
        )
    assert first.events == second.events
    await hub.close()


def _make_file(path: Path, content: str = "content") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _revision(content: bytes) -> str:
    return f"sha256:{hashlib.sha256(content).hexdigest()}"
