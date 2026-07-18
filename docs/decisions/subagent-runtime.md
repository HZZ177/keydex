# Session-backed Sub-Agent Runtime

Status: accepted for V1 implementation. The machine-readable source ledger is
[`subagent-runtime-references.json`](./subagent-runtime-references.json).

## Terms and identity

- A **Sub-Agent instance** is the stable identity `subagent_id`. It owns one hidden
  `child_session_id` and can be resumed after a terminal Run.
- A **Run** is one execution identified by `run_id`. It starts queued, can run, and
  ends exactly once as completed, failed, cancelled, or interrupted.
- The **Invocation Policy** is how a caller consumes a Runtime handle. V1 uses WAIT,
  but WAIT is not a mode on the Runtime and never directly awaits a child task.
- A **capsule** is the parent-timeline projection of exactly one Run. Child messages,
  reasoning, approvals, and tools remain in the hidden child Session.

## Accepted decisions

1. `SubagentRuntime.spawn()` persists an addressable child Session and Run, schedules
   execution, and returns a handle before the child is terminal.
2. The model-facing `delegate_subagent(type, task)` accepts only immutable Explorer or
   Worker presets plus a task. Its V1 policy awaits `wait_terminal(run_id)` and returns
   only a structured terminal result and final report.
3. Explorer is deny-by-default and read-only at both assembly and invocation
   boundaries. Worker inherits main Workspace capability but never receives the
   delegation tool. Multiple Explorers and Workers may run concurrently.
4. Instance state is derived as idle, running, or closed. Run state is queued,
   running, completed, failed, cancelled, or interrupted; `blocked_on` is orthogonal.
5. Runs are durable, versioned, atomically transitioned, and terminally immutable.
   Notifications accelerate observation; repository snapshots are the fact source.
6. Child Sessions are `visibility=internal`. Normal lists, recent/search/pinned/unread,
   restore, and export paths exclude them. A parent may open one only through a
   validated parent/run relationship.
7. Resume preserves `subagent_id` and `child_session_id` while creating a new
   `run_id`, timeline sequence, and capsule. Restart-orphaned active Runs become
   interrupted and are not replayed automatically.
8. `delegate_subagent` is a transport-level invocation anchor, not an ordinary
   parent-timeline ToolBlock. The desktop promotes it to a semantic Sub-Agent
   invocation placeholder, then replaces that placeholder with the correlated
   `subagent_run_updated` snapshot. The Run event is the presentation fact source;
   clicking its capsule opens the hidden child Session in a live Sidecar.
9. A child Agent loop and its finish callback start in isolated Python contexts.
   They never inherit the parent tool's LangChain runnable/callback context; otherwise
   the parent's event processor would observe and persist the child transcript in
   addition to the child's own Session projection.
10. Already-persisted duplicate parent messages are not deleted automatically. The
    affected legacy events do not carry a reliable child marker, so time-window or
    content-based cleanup could remove legitimate parent activity.

## Rejected decisions

- Directly awaiting `child_agent.ainvoke()` as the lifecycle boundary.
- Reusing a Trace status or Session alone instead of a dedicated Run record.
- Copying Codex AgentControl, canonical task paths, mailbox, budgets, nested agent
  trees, or its full model-visible multi-agent tool set.
- A Claude-style one-shot, stateless, non-addressable task wrapper.
- Treating prompt text as the Explorer security boundary.
- Hiding child Sessions only in the UI, or merging resume history by `subagent_id`.
- Expanding approvals and input waits into additional lifecycle states.

## Source interpretation rule

Codex behavior is tied to the exact upstream commit in the ledger. Claude Code is a
closed-source product: the listed 1.0.33 file is a local reverse-analysis snapshot,
not an upstream open-source implementation. It is used only for the explicitly
described historical behavior. The old Keydex base is used to explain the former
one-shot boundary, not as the new control-plane implementation.
