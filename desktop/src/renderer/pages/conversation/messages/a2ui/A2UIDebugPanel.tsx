import { Check, Copy, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { A2UIDebugRawEvent } from "@/types/protocol";

import { copyText } from "../markdown";
import type { ParsedA2UIMessage } from "./A2UIBlock";
import styles from "./A2UIDebugPanel.module.css";

export interface A2UIDebugPanelProps {
  message: ConversationMessage;
  parsed: ParsedA2UIMessage;
  onClose: () => void;
}

type CopyState = "idle" | "copied" | "failed";

export function A2UIDebugPanel({ message, parsed, onClose }: A2UIDebugPanelProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const rawEvents = parsed.debug?.rawEvents ?? [];
  const streamBuffer = useMemo(() => buildStreamBuffer(parsed), [parsed]);
  const eventTimeline = useMemo(() => buildRawEventTimeline(rawEvents), [rawEvents]);
  const snapshot = useMemo(
    () => buildDebugSnapshot(message, parsed, streamBuffer, eventTimeline),
    [message, parsed, streamBuffer, eventTimeline],
  );
  const json = useMemo(() => stringifyJson(snapshot), [snapshot]);

  const copyJson = async () => {
    try {
      await copyText(json);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <section className={styles.panel} data-testid="a2ui-debug-panel" aria-label="A2UI 调试信息">
      <header className={styles.header}>
        <div>
          <div className={styles.title}>A2UI 调试信息</div>
          <div className={styles.subtitle}>
            {parsed.renderKey} · {parsed.interactionId || parsed.debug?.streamId || message.id}
          </div>
        </div>
        <div className={styles.actions}>
          <button
            className={styles.actionButton}
            type="button"
            aria-label="复制调试 JSON"
            data-copy-state={copyState}
            onClick={() => void copyJson()}
          >
            {copyState === "copied" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            <span>{copyState === "failed" ? "复制失败" : copyState === "copied" ? "已复制" : "复制 JSON"}</span>
          </button>
          <button className={styles.iconButton} type="button" aria-label="关闭调试信息" onClick={onClose}>
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className={styles.summaryBar}>
        <SummaryItem label="status" value={parsed.status} tone={statusTone(parsed.status)} />
        <SummaryItem label="stream" value={parsed.debug?.streamId ?? parsed.a2ui?.stream_id} />
        <SummaryItem label="chunks" value={streamBuffer.chunkCount} />
        <SummaryItem label="parse" value={streamBuffer.jsonParseStatus} tone={parseTone(streamBuffer.jsonParseStatus)} />
        <SummaryItem label="events" value={rawEvents.length} />
      </div>

      <DebugSection
        title="定位信息"
        rows={[
          ["message_id", message.id],
          ["item_id", message.itemId],
          ["render_key", parsed.renderKey],
          ["mode", parsed.mode],
          ["stream_id", parsed.a2ui?.stream_id ?? parsed.debug?.streamId],
          ["interaction_id", parsed.interactionId],
          ["tool_call_id", parsed.a2ui?.tool_call_id ?? parsed.debug?.toolCallId],
          ["trace_id", parsed.a2ui?.trace_id ?? parsed.debug?.traceId],
          ["turn_index", parsed.a2ui?.turn_index ?? parsed.debug?.turnIndex],
        ]}
      />

      <DebugSection
        title="生命周期"
        rows={[
          ["status", parsed.status],
          ["interaction.status", parsed.interaction?.status],
          ["can_submit", parsed.interaction?.can_submit],
          ["submit_request_id", parsed.interaction?.submit_request_id],
          ["cancel_request_id", parsed.interaction?.cancel_request_id],
          ["resume.status", parsed.interaction?.resume_status],
          ["resume_group_id", parsed.interaction?.resume_group_id],
          ["pending_count", parsed.interaction?.pending_count],
          ["resume_error", parsed.interaction?.resume_error ?? parsed.interaction?.error],
        ]}
      />

      <StreamBufferPanel buffer={streamBuffer} />
      <RawEventsTimeline events={eventTimeline} />

      <DebugSection
        title="交互结果"
        rows={[
          ["submit_result", parsed.interaction?.submit_result],
          ["cancel_reason", parsed.interaction?.cancel_reason],
        ]}
      />

      <JsonBlock title="最终 Payload" value={parsed.payload} />
      <JsonBlock title="Parsed Preview" value={parsed.debug?.parsedArgs ?? parsed.debug?.payload ?? parsed.payload} />
      <JsonBlock title="Created Frame" value={parsed.debug?.createdFrame ?? null} />
      <JsonBlock title="Input Schema" value={parsed.a2ui?.input_schema ?? parsed.debug?.inputSchema ?? {}} />
      <JsonBlock title="Submit Schema" value={parsed.a2ui?.submit_schema ?? parsed.debug?.submitSchema ?? {}} />
    </section>
  );
}

function SummaryItem({ label, value, tone = "neutral" }: { label: string; value: unknown; tone?: string }) {
  return (
    <div className={styles.summaryItem} data-tone={tone}>
      <span>{label}</span>
      <strong title={formatValue(value)}>{formatValue(value)}</strong>
    </div>
  );
}

function DebugSection({ title, rows }: { title: string; rows: Array<[string, unknown]> }) {
  return (
    <section className={styles.section}>
      <h4>{title}</h4>
      <dl className={styles.grid}>
        {rows.map(([label, value]) => (
          <div className={styles.row} key={label}>
            <dt>{label}</dt>
            <dd title={formatValue(value)}>{formatValue(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function StreamBufferPanel({ buffer }: { buffer: StreamBufferView }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h4>Stream Buffer</h4>
        <span>{buffer.bufferLength} chars</span>
      </div>
      <div className={styles.bufferGrid}>
        <DebugMetric label="phase" value={buffer.status} tone={statusTone(buffer.status)} />
        <DebugMetric label="chunk_count" value={buffer.chunkCount} />
        <DebugMetric label="args_text_length" value={buffer.argsTextLength} />
        <DebugMetric label="buffer_length" value={buffer.bufferLength} />
        <DebugMetric label="json_parse_status" value={buffer.jsonParseStatus} tone={parseTone(buffer.jsonParseStatus)} />
        <DebugMetric label="finish_reason" value={buffer.finishReason} />
        <DebugMetric label="payload_keys" value={buffer.payloadKeys.join(", ") || "-"} />
        <DebugMetric label="latest_chunk_length" value={buffer.latestChunk.length} />
      </div>
      <div className={styles.bufferColumns}>
        <CodePane title="argsBuffer" value={buffer.argsBuffer || "-"} testId="a2ui-debug-stream-buffer" />
        <CodePane title="latestChunk" value={buffer.latestChunk || "-"} testId="a2ui-debug-latest-chunk" />
      </div>
      {buffer.parseError ? (
        <div className={styles.errorLine}>
          <span>parse_error</span>
          <code>{buffer.parseError}</code>
        </div>
      ) : null}
    </section>
  );
}

function DebugMetric({ label, value, tone = "neutral" }: { label: string; value: unknown; tone?: string }) {
  return (
    <div className={styles.metric} data-tone={tone}>
      <span>{label}</span>
      <strong title={formatValue(value)}>{formatValue(value)}</strong>
    </div>
  );
}

function RawEventsTimeline({ events }: { events: RawEventView[] }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h4>Raw Events</h4>
        <span>{events.length} events</span>
      </div>
      <div className={styles.eventList} data-testid="a2ui-debug-raw-events">
        {events.length ? (
          events.map((event) => (
            <article className={styles.eventItem} key={event.id}>
              <div className={styles.eventMain}>
                <span className={styles.eventIndex}>#{event.index + 1}</span>
                <span className={styles.eventTime}>{event.timeLabel}</span>
                <span className={styles.eventAction} data-action={event.actionClass}>
                  {event.action}
                </span>
                <span className={styles.eventSummary}>{event.summary}</span>
              </div>
              {event.chunkText !== null ? (
                <pre className={styles.chunkText} data-testid={`a2ui-debug-raw-event-${event.index}-chunk`}>
                  {event.chunkText || "(empty chunk)"}
                </pre>
              ) : null}
              <details className={styles.eventDetails}>
                <summary>event.data</summary>
                <pre>{event.dataJson}</pre>
              </details>
            </article>
          ))
        ) : (
          <div className={styles.emptyState}>暂无 Raw Events</div>
        )}
      </div>
    </section>
  );
}

function CodePane({ title, value, testId }: { title: string; value: string; testId?: string }) {
  return (
    <div className={styles.codePane}>
      <div className={styles.codePaneTitle}>{title}</div>
      <pre data-testid={testId}>{value}</pre>
    </div>
  );
}

function JsonBlock({ title, value, testId }: { title: string; value: unknown; testId?: string }) {
  return (
    <section className={styles.section}>
      <h4>{title}</h4>
      <pre className={styles.json} data-testid={testId}>
        {typeof value === "string" ? value || "-" : stringifyJson(value)}
      </pre>
    </section>
  );
}

interface StreamBufferView {
  status: string;
  chunkCount: number;
  argsBuffer: string;
  argsTextLength: number;
  bufferLength: number;
  latestChunk: string;
  jsonParseStatus: string;
  parseError: string | null;
  finishReason: string | null;
  payloadKeys: string[];
  parsedPreview: unknown;
}

interface RawEventView {
  id: string;
  index: number;
  action: string;
  actionClass: string;
  timeLabel: string;
  summary: string;
  chunkText: string | null;
  dataJson: string;
  data: Record<string, unknown>;
}

function buildStreamBuffer(parsed: ParsedA2UIMessage): StreamBufferView {
  const debug = parsed.debug;
  const argsBuffer = String(debug?.argsBuffer ?? "");
  const latestChunk = String(debug?.latestChunk ?? "");
  const parsedPreview = debug?.parsedArgs ?? debug?.payload ?? parsed.payload;
  return {
    status: String(debug?.status ?? parsed.status ?? "idle"),
    chunkCount: Number(debug?.chunkCount ?? 0),
    argsBuffer,
    argsTextLength: Number(debug?.argsTextLength ?? argsBuffer.length),
    bufferLength: argsBuffer.length,
    latestChunk,
    jsonParseStatus: String(debug?.jsonParseStatus ?? "empty"),
    parseError: debug?.parseError ? String(debug.parseError) : null,
    finishReason: debug?.finishReason ? String(debug.finishReason) : null,
    payloadKeys: payloadKeys(parsedPreview),
    parsedPreview,
  };
}

function buildRawEventTimeline(events: A2UIDebugRawEvent[]): RawEventView[] {
  return events.map((event, index) => {
    const data = isRecord(event.data) ? event.data : {};
    const stream = isRecord(data.stream) ? data.stream : {};
    const a2ui = isRecord(data.a2ui) ? data.a2ui : {};
    const action = String(event.action || "unknown");
    const chunkIndex = numberValue(stream.chunk_index, stream.chunkIndex);
    const argsDelta = stringValue(stream.args_delta, stream.argsDelta, data.args_delta);
    const argsText = stringValue(stream.args_text, stream.argsText, data.args_text);
    const argsTextLength = numberValue(stream.args_text_length, stream.argsTextLength, data.args_text_length);
    const streamStatus = stringValue(stream.status);
    const streamId = stringValue(data.stream_id, data.streamId, a2ui.stream_id);
    const interactionId = stringValue(data.interaction_id, data.interactionId, a2ui.interaction_id);
    const renderKey = stringValue(data.render_key, data.renderKey, a2ui.render_key);
    const chunkText = argsDelta ?? (action.includes("stream_chunk") ? argsText ?? "" : null);
    const summaryParts: string[] = [];

    if (renderKey) {
      summaryParts.push(`render=${renderKey}`);
    }
    if (streamStatus) {
      summaryParts.push(`status=${streamStatus}`);
    }
    if (chunkIndex !== undefined) {
      summaryParts.push(`chunk=${chunkIndex}`);
    }
    if (chunkText !== null) {
      summaryParts.push(`delta=${chunkText.length} chars`);
    }
    if (argsTextLength !== undefined) {
      summaryParts.push(`buffer=${argsTextLength}`);
    }
    if (streamId) {
      summaryParts.push(`stream=${shortId(streamId)}`);
    }
    if (interactionId) {
      summaryParts.push(`interaction=${shortId(interactionId)}`);
    }
    if (!summaryParts.length) {
      summaryParts.push(summarizeEventData(data));
    }

    return {
      id: event.id || `${action}:${event.timestamp}:${index}`,
      index,
      action,
      actionClass: action.replace(/[._]/g, "-"),
      timeLabel: formatTimestamp(event.timestamp),
      summary: summaryParts.join(" · "),
      chunkText,
      dataJson: stringifyJson(data),
      data,
    };
  });
}

function buildDebugSnapshot(
  message: ConversationMessage,
  parsed: ParsedA2UIMessage,
  streamBuffer: StreamBufferView,
  rawEventTimeline: RawEventView[],
) {
  return {
    ids: {
      message_id: message.id,
      item_id: message.itemId,
      thread_id: message.threadId,
      render_key: parsed.renderKey,
      mode: parsed.mode,
      stream_id: parsed.a2ui?.stream_id ?? parsed.debug?.streamId ?? null,
      interaction_id: parsed.interactionId || null,
      tool_call_id: parsed.a2ui?.tool_call_id ?? parsed.debug?.toolCallId ?? null,
      trace_id: parsed.a2ui?.trace_id ?? parsed.debug?.traceId ?? null,
      turn_index: parsed.a2ui?.turn_index ?? parsed.debug?.turnIndex ?? null,
    },
    lifecycle: {
      status: parsed.status,
      interaction_status: parsed.interaction?.status ?? null,
      can_submit: parsed.interaction?.can_submit ?? null,
      submit_request_id: parsed.interaction?.submit_request_id ?? null,
      cancel_request_id: parsed.interaction?.cancel_request_id ?? null,
      resume_status: parsed.interaction?.resume_status ?? null,
      resume_group_id: parsed.interaction?.resume_group_id ?? null,
      pending_count: parsed.interaction?.pending_count ?? null,
      resume_error: parsed.interaction?.resume_error ?? parsed.interaction?.error ?? null,
    },
    stream_buffer: streamBuffer,
    stream: {
      chunk_count: streamBuffer.chunkCount,
      args_text_length: streamBuffer.argsTextLength,
      json_parse_status: streamBuffer.jsonParseStatus,
      finish_reason: streamBuffer.finishReason,
      latest_chunk: streamBuffer.latestChunk,
      args_buffer: streamBuffer.argsBuffer,
      parsed_preview: streamBuffer.parsedPreview,
    },
    a2ui: parsed.a2ui,
    payload: parsed.payload,
    input_schema: parsed.a2ui?.input_schema ?? parsed.debug?.inputSchema ?? {},
    submit_schema: parsed.a2ui?.submit_schema ?? parsed.debug?.submitSchema ?? {},
    submit_result: parsed.interaction?.submit_result ?? null,
    cancel_reason: parsed.interaction?.cancel_reason ?? null,
    raw_event_timeline: rawEventTimeline.map(({ dataJson: _dataJson, ...event }) => event),
    raw_events: parsed.debug?.rawEvents ?? [],
  };
}

function payloadKeys(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.keys(value);
}

function summarizeEventData(data: Record<string, unknown>): string {
  const keys = Object.keys(data);
  if (!keys.length) {
    return "(empty)";
  }
  return keys.slice(0, 6).join(", ");
}

function shortId(value: string): string {
  if (value.length <= 28) {
    return value;
  }
  return `${value.slice(0, 12)}...${value.slice(-8)}`;
}

function formatTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "-";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return String(timestamp);
  }
  return date.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

function statusTone(status: unknown): string {
  const text = String(status ?? "").toLowerCase();
  if (["failed", "cancelled", "invalid"].some((item) => text.includes(item))) {
    return "danger";
  }
  if (["submitted", "created", "finished", "valid", "completed"].some((item) => text.includes(item))) {
    return "success";
  }
  if (["waiting", "streaming", "started", "partial"].some((item) => text.includes(item))) {
    return "warning";
  }
  return "neutral";
}

function parseTone(status: unknown): string {
  const text = String(status ?? "").toLowerCase();
  if (text === "valid") {
    return "success";
  }
  if (text === "invalid") {
    return "danger";
  }
  if (text === "partial") {
    return "warning";
  }
  return "neutral";
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return stringifyJson(value);
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return undefined;
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value);
  }
}
