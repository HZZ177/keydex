export interface RuntimeErrorEnvelope {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
  status?: number;
}

export class RuntimeError extends Error implements RuntimeErrorEnvelope {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly status?: number;
  readonly retryable?: boolean;

  constructor(envelope: RuntimeErrorEnvelope) {
    super(envelope.message);
    this.name = "RuntimeError";
    this.code = envelope.code;
    this.details = envelope.details;
    this.status = envelope.status;
    this.retryable = envelope.retryable;
  }
}

export interface RuntimeHttpErrorParams extends RuntimeErrorEnvelope {
  method: string;
  path: string;
  body: unknown;
  rawText: string;
}

export class RuntimeHttpError extends RuntimeError {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly rawText: string;

  constructor(params: RuntimeHttpErrorParams) {
    super({
      code: params.code,
      message: params.message,
      details: params.details,
      status: params.status,
      retryable: params.retryable,
    });
    this.name = "RuntimeHttpError";
    this.method = params.method;
    this.path = params.path;
    this.body = params.body;
    this.rawText = params.rawText;
  }
}

export function isRuntimeHttpError(error: unknown): error is RuntimeHttpError {
  return (
    error instanceof RuntimeHttpError ||
    (Boolean(error) &&
      typeof error === "object" &&
      (error as { name?: unknown }).name === "RuntimeHttpError" &&
      typeof (error as { status?: unknown }).status === "number" &&
      typeof (error as { code?: unknown }).code === "string")
  );
}

export function notImplemented(message = "该能力尚未实现"): RuntimeError {
  return new RuntimeError({ code: "not_implemented", message });
}
