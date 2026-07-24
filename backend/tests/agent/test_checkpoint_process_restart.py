from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

_WRITER = r"""
import asyncio
import sys
from langchain_core.messages import AIMessage, HumanMessage
from backend.app.agent.checkpoint_runtime import CheckpointRuntime
from backend.app.agent.state import CHECKPOINT_STATE_UPDATE_NODE, build_checkpoint_state_graph

async def main():
    runtime = CheckpointRuntime(sys.argv[1])
    assert await runtime.start()
    try:
        graph = build_checkpoint_state_graph(runtime.require_store())
        await graph.aupdate_state(
            {"configurable": {"thread_id": "process-restart", "checkpoint_ns": ""}},
            {
                "messages": [
                    HumanMessage(content="visible request", id="visible"),
                    HumanMessage(
                        content="hidden injected context",
                        id="hidden",
                        additional_kwargs={"hidden_for_transcript": True},
                    ),
                    AIMessage(content="persisted answer", id="answer"),
                ]
            },
            as_node=CHECKPOINT_STATE_UPDATE_NODE,
        )
    finally:
        await runtime.close()

asyncio.run(main())
"""


_READER = r"""
import asyncio
import hashlib
import json
import sys
from backend.app.agent.checkpoint_runtime import CheckpointRuntime
from backend.app.agent.state import build_checkpoint_state_graph

async def main():
    runtime = CheckpointRuntime(sys.argv[1])
    assert await runtime.start()
    try:
        graph = build_checkpoint_state_graph(runtime.require_store())
        snapshot = await graph.aget_state(
            {"configurable": {"thread_id": "process-restart", "checkpoint_ns": ""}}
        )
        messages = snapshot.values["messages"]
        contents = [str(message.content) for message in messages]
        payload = {
            "types": [message.type for message in messages],
            "contents": contents,
            "hidden": [
                bool(message.additional_kwargs.get("hidden_for_transcript"))
                for message in messages
            ],
            "digest": hashlib.sha256(
                json.dumps(contents, ensure_ascii=False).encode("utf-8")
            ).hexdigest(),
        }
        print("CHECKPOINT_RESULT=" + json.dumps(payload, ensure_ascii=False))
    finally:
        await runtime.close()

asyncio.run(main())
"""


def _run_process(script: str, database_path: Path) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, "-c", script, str(database_path)],
        cwd=Path(__file__).resolve().parents[3],
        env=environment,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
    )


def test_delta_checkpoint_model_context_survives_clean_process_restart(tmp_path) -> None:
    database_path = tmp_path / "process-restart.db"
    _run_process(_WRITER, database_path)

    restarted = _run_process(_READER, database_path)
    result_line = next(
        line
        for line in restarted.stdout.splitlines()
        if line.startswith("CHECKPOINT_RESULT=")
    )
    payload = json.loads(result_line.removeprefix("CHECKPOINT_RESULT="))
    contents = [
        "visible request",
        "hidden injected context",
        "persisted answer",
    ]

    assert payload == {
        "types": ["human", "human", "ai"],
        "contents": contents,
        "hidden": [False, True, False],
        "digest": hashlib.sha256(
            json.dumps(contents, ensure_ascii=False).encode("utf-8")
        ).hexdigest(),
    }
