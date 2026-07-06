import { Check, ClipboardList, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import type { McpElicitationResolvePayload } from "@/types/protocol";

import styles from "./McpElicitationPrompt.module.css";

export type McpElicitationResolveHandler = (payload: McpElicitationResolvePayload) => Promise<void> | void;

export interface McpElicitationPromptProps {
  message: ConversationMessage;
  onResolve?: McpElicitationResolveHandler;
}

export function McpElicitationPrompt({ message, onResolve }: McpElicitationPromptProps) {
  const request = useMemo(() => parseElicitation(message), [message]);
  const fields = useMemo(() => schemaFields(request.schema), [request.schema]);
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<"submit" | "cancel" | null>(null);
  const pending = request.status === "pending" && message.status === "pending";
  const actionable = pending && Boolean(onResolve) && !submitting;

  useEffect(() => {
    setValues(initialValues(fields));
    setErrors({});
    setSubmitting(null);
  }, [fields, request.elicitationId, request.status]);

  const updateValue = (field: ElicitationField, value: unknown) => {
    setValues((current) => ({ ...current, [field.name]: normalizeFieldValue(field, value) }));
    setErrors((current) => {
      if (!current[field.name]) {
        return current;
      }
      const next = { ...current };
      delete next[field.name];
      return next;
    });
  };

  const submit = async () => {
    if (!request.elicitationId || !onResolve || !actionable) {
      return;
    }
    const validation = validateValues(fields, values);
    if (Object.keys(validation).length) {
      setErrors(validation);
      return;
    }
    setSubmitting("submit");
    try {
      await onResolve({
        elicitation_id: request.elicitationId,
        values: valuesForSubmit(fields, values),
      });
    } finally {
      setSubmitting(null);
    }
  };

  const cancel = async () => {
    if (!request.elicitationId || !onResolve || !actionable) {
      return;
    }
    setSubmitting("cancel");
    try {
      await onResolve({
        elicitation_id: request.elicitationId,
        cancelled: true,
      });
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <article className={styles.block} data-status={request.status} data-testid="mcp-elicitation-prompt">
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          {request.status === "cancelled" || request.status === "timeout" ? <XCircle size={16} /> : <ClipboardList size={16} />}
        </span>
        <div className={styles.titleGroup}>
          <div className={styles.title}>{request.title}</div>
          <div className={styles.meta}>
            <span>MCP Elicitation</span>
            <span>{statusLabel(request.status)}</span>
            {request.serverLabel ? <span>{request.serverLabel}</span> : null}
            {request.toolLabel ? <span className={styles.target}>{request.toolLabel}</span> : null}
          </div>
        </div>
      </header>

      {request.description ? <p className={styles.description}>{request.description}</p> : null}
      {request.riskText ? <p className={styles.riskText}>风险说明：{request.riskText}</p> : null}

      {pending ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {fields.length ? (
            fields.map((field) => (
              <FieldControl
                key={field.name}
                field={field}
                value={values[field.name]}
                error={errors[field.name]}
                disabled={!actionable}
                onChange={(value) => updateValue(field, value)}
              />
            ))
          ) : (
            <p className={styles.empty}>该请求未声明字段。</p>
          )}
          <div className={styles.actions}>
            <button className={styles.cancelButton} type="button" disabled={!actionable || submitting === "submit"} onClick={() => void cancel()}>
              <XCircle size={14} />
              <span>{submitting === "cancel" ? "正在取消" : "取消"}</span>
            </button>
            <button className={styles.submitButton} type="submit" disabled={!actionable || submitting === "cancel"}>
              <Check size={14} />
              <span>{submitting === "submit" ? "正在提交" : "提交"}</span>
            </button>
          </div>
        </form>
      ) : (
        <div className={styles.resolvedState}>{resolvedStateText(request.status)}</div>
      )}
    </article>
  );
}

function FieldControl({
  disabled,
  error,
  field,
  value,
  onChange,
}: {
  disabled: boolean;
  error?: string;
  field: ElicitationField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const describedBy = error ? `${field.name}-error` : undefined;
  return (
    <label className={styles.field} data-kind={field.kind}>
      <span className={styles.fieldLabel}>
        <span>{field.label}</span>
        {field.required ? <span className={styles.required}>必填</span> : null}
      </span>
      {field.description ? <span className={styles.fieldDescription}>{field.description}</span> : null}
      {field.kind === "select" ? (
        <select
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          <option value="">请选择</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : field.kind === "textarea" ? (
        <textarea
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          rows={4}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      ) : field.kind === "checkbox" ? (
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
      ) : (
        <input
          type={field.secret ? "password" : field.numeric ? "number" : "text"}
          value={typeof value === "string" || typeof value === "number" ? value : ""}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          autoComplete={field.secret ? "off" : undefined}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
      {error ? (
        <span className={styles.errorText} id={describedBy}>
          {error}
        </span>
      ) : null}
    </label>
  );
}

interface ParsedElicitation {
  elicitationId: string;
  title: string;
  status: "pending" | "submitted" | "cancelled" | "timeout";
  serverLabel: string;
  toolLabel: string;
  description: string;
  riskText: string;
  schema: Record<string, unknown>;
}

interface ElicitationField {
  name: string;
  label: string;
  description: string;
  required: boolean;
  kind: "input" | "select" | "textarea" | "checkbox";
  options: string[];
  numeric: boolean;
  secret: boolean;
}

function parseElicitation(message: ConversationMessage): ParsedElicitation {
  const elicitation = asRecord(message.payload.elicitation) ?? {};
  const schema = asRecord(elicitation.schema) ?? {};
  const status = normalizeStatus(stringValue(elicitation.status) || stringValue(message.status));
  return {
    elicitationId: stringValue(elicitation.elicitation_id) || stringValue(elicitation.id),
    title: stringValue(elicitation.title) || message.content || "MCP 请求补充信息",
    status,
    serverLabel: stringValue(elicitation.server_name) || stringValue(elicitation.server_id),
    toolLabel: stringValue(elicitation.raw_tool_name),
    description: stringValue(schema.description) || stringValue(elicitation.description),
    riskText: listText(elicitation.risk_reasons) || listText(schema.risk_reasons),
    schema,
  };
}

function schemaFields(schema: Record<string, unknown>): ElicitationField[] {
  const properties = asRecord(schema.properties) ?? {};
  const required = new Set(stringArray(schema.required));
  return Object.entries(properties).map(([name, value]) => {
    const property = asRecord(value) ?? {};
    const type = stringValue(property.type);
    const options = stringArray(property.enum);
    const secret = isSecretField(name, property);
    return {
      name,
      label: stringValue(property.title) || name,
      description: stringValue(property.description),
      required: required.has(name),
      kind: fieldKind(name, property, type, options),
      options,
      numeric: type === "number" || type === "integer",
      secret,
    };
  });
}

function fieldKind(
  name: string,
  property: Record<string, unknown>,
  type: string,
  options: string[],
): ElicitationField["kind"] {
  if (options.length) {
    return "select";
  }
  if (type === "boolean") {
    return "checkbox";
  }
  if (
    stringValue(property.format) === "textarea" ||
    stringValue(property.format) === "multiline" ||
    stringValue(property["ui:widget"]) === "textarea" ||
    stringValue(property.widget) === "textarea" ||
    numberValue(property.maxLength) > 160 ||
    /description|summary|body|comment|notes?/iu.test(name)
  ) {
    return "textarea";
  }
  return "input";
}

function initialValues(fields: ElicitationField[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field.name, field.kind === "checkbox" ? false : ""]));
}

function normalizeFieldValue(field: ElicitationField, value: unknown): unknown {
  if (field.kind === "checkbox") {
    return value === true;
  }
  if (field.numeric && typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}

function validateValues(fields: ElicitationField[], values: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  fields.forEach((field) => {
    const value = values[field.name];
    if (!field.required) {
      return;
    }
    if (field.kind === "checkbox") {
      if (value !== true) {
        errors[field.name] = "请确认该选项";
      }
      return;
    }
    if (value === undefined || value === null || String(value).trim() === "") {
      errors[field.name] = "请填写该字段";
    }
  });
  return errors;
}

function valuesForSubmit(fields: ElicitationField[], values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  fields.forEach((field) => {
    const value = values[field.name];
    if (field.kind === "checkbox") {
      result[field.name] = value === true;
      return;
    }
    if (value === undefined || value === null) {
      return;
    }
    if (typeof value === "string" && !value.trim() && !field.required) {
      return;
    }
    result[field.name] = value;
  });
  return result;
}

function normalizeStatus(value: string): ParsedElicitation["status"] {
  if (value === "submitted" || value === "cancelled" || value === "timeout") {
    return value;
  }
  return "pending";
}

function statusLabel(status: ParsedElicitation["status"]): string {
  switch (status) {
    case "pending":
      return "等待输入";
    case "submitted":
      return "已提交";
    case "cancelled":
      return "已取消";
    case "timeout":
      return "已超时";
  }
}

function resolvedStateText(status: ParsedElicitation["status"]): string {
  if (status === "submitted") {
    return "已提交补充信息，工具调用继续执行。";
  }
  if (status === "cancelled") {
    return "已取消补充信息请求，工具调用将停止。";
  }
  if (status === "timeout") {
    return "补充信息请求已超时，工具调用将停止。";
  }
  return "";
}

function isSecretField(name: string, property: Record<string, unknown>): boolean {
  return (
    stringValue(property.format) === "password" ||
    property.writeOnly === true ||
    property.secret === true ||
    property["x-secret"] === true ||
    /secret|token|password|api[_-]?key|credential/iu.test(name)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function listText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(stringValue).filter(Boolean).join("；");
  }
  return stringValue(value);
}
