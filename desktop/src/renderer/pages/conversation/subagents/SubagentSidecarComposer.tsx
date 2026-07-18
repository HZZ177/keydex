import { useState, type FormEvent } from "react";

import type { RuntimeBridge } from "@/runtime";
import { useOptionalAgentSessionRuntime } from "@/renderer/providers/AgentSessionProvider";
import { isActiveSubagentRun, type SubagentRunSnapshot } from "@/types/subagents";

import styles from "./SubagentSidecarComposer.module.css";

export function SubagentSidecarComposer({
  runtime,
  run,
  isCurrentRun,
}: {
  runtime: RuntimeBridge;
  run: SubagentRunSnapshot;
  isCurrentRun: boolean;
}) {
  const agentRuntime = useOptionalAgentSessionRuntime();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<"submit" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = isActiveSubagentRun(run.state);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const message = value.trim();
    if (!message || busy || !isCurrentRun) return;
    setBusy("submit");
    setError(null);
    try {
      const updated = await runtime.conversation.steerSubagent(
        run.parent_session_id,
        run.run_id,
        controlAddress(run, { message }),
      );
      agentRuntime?.applySubagentSnapshot(updated);
      setValue("");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (!active || busy || !isCurrentRun) return;
    setBusy("cancel");
    setError(null);
    try {
      const updated = await runtime.conversation.cancelSubagent(
        run.parent_session_id,
        run.run_id,
        controlAddress(run, { reason: "user" }),
      );
      agentRuntime?.applySubagentSnapshot(updated);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  };

  if (!isCurrentRun) {
    return (
      <div className={styles.readonly} role="status" data-testid="subagent-historical-run-notice">
        这是历史 Run，可查看完整过程，但不能在此发送引导或取消。
      </div>
    );
  }

  if (!active) {
    return (
      <div className={styles.readonly} role="status" data-testid="subagent-terminal-run-notice">
        此 Sub-Agent Run 已结束，仅可查看。只有主 Agent 可以委派新的 Sub-Agent。
      </div>
    );
  }

  return (
    <form className={styles.composer} onSubmit={submit} data-testid="subagent-sidecar-composer">
      <label className={styles.label} htmlFor={`subagent-composer:${run.run_id}`}>
        中途引导 Sub-Agent
      </label>
      <textarea
        id={`subagent-composer:${run.run_id}`}
        value={value}
        rows={2}
        maxLength={10_000}
        disabled={Boolean(busy)}
        placeholder="补充约束、纠正方向或提供新线索…"
        onChange={(event) => setValue(event.currentTarget.value)}
      />
      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      <div className={styles.actions}>
        <button type="button" className={styles.cancel} disabled={Boolean(busy)} onClick={() => void cancel()}>
          {busy === "cancel" ? "正在取消…" : "取消当前 Run"}
        </button>
        <button type="submit" className={styles.submit} disabled={Boolean(busy) || !value.trim()}>
          {busy === "submit" ? "正在发送…" : "发送引导"}
        </button>
      </div>
    </form>
  );
}

function controlAddress<T extends Record<string, unknown>>(
  run: SubagentRunSnapshot,
  extra: T,
): T & { subagent_id: string; child_session_id: string; expected_version: number } {
  return {
    subagent_id: run.subagent_id,
    child_session_id: run.child_session_id,
    expected_version: run.version,
    ...extra,
  };
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  return String(reason || "Sub-Agent 操作失败");
}
