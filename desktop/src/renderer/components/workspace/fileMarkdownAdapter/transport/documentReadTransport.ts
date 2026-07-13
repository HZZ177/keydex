import {
  DocumentReadAssembler,
  DocumentReadProtocolError,
  type DocumentReadMessage,
  type DocumentReadRequest,
  type DocumentReadResult,
} from "@/runtime/documentRead";

export interface DocumentReadTransportDiagnostics {
  readonly requestId: string;
  readonly receivedBytes: number;
  readonly acceptedMessages: number;
  readonly peakBufferedTextBytes: number;
  readonly peakHeapBytes: number | null;
  readonly elapsedMs: number;
  readonly complete: boolean;
}

export interface DocumentReadTransportOptions {
  signal?: AbortSignal;
  onDiagnostics?: (diagnostics: DocumentReadTransportDiagnostics) => void;
  diagnosticsIntervalMs?: number;
  now?: () => number;
}

export async function readDocumentNdjsonResponse(
  response: Response,
  request: DocumentReadRequest,
  options: DocumentReadTransportOptions = {},
): Promise<DocumentReadResult> {
  const assembler = new DocumentReadAssembler(request);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reader = response.body?.getReader();
  const diagnosticsEnabled = options.onDiagnostics !== undefined;
  const now = options.now ?? (() => performance.now());
  const startedAt = diagnosticsEnabled ? now() : 0;
  const diagnosticsIntervalMs = options.diagnosticsIntervalMs ?? 100;
  let lastDiagnosticsAt = startedAt;
  let receivedBytes = 0;
  let acceptedMessages = 0;
  let peakBufferedTextBytes = 0;
  let peakHeapBytes = diagnosticsEnabled ? sampleHeapBytes() : null;
  let bufferedText = "";
  let result: DocumentReadResult | null = null;

  const emitDiagnostics = (complete: boolean) => {
    if (!options.onDiagnostics) return;
    const timestamp = now();
    if (!complete && timestamp - lastDiagnosticsAt < diagnosticsIntervalMs) return;
    lastDiagnosticsAt = timestamp;
    options.onDiagnostics(Object.freeze({
      requestId: request.request_id,
      receivedBytes,
      acceptedMessages,
      peakBufferedTextBytes,
      peakHeapBytes,
      elapsedMs: Math.max(0, timestamp - startedAt),
      complete,
    }));
  };

  const acceptLine = (line: string) => {
    if (!line.trim()) return;
    assertNotAborted(options.signal);
    let message: DocumentReadMessage;
    try {
      message = JSON.parse(line) as DocumentReadMessage;
    } catch (error) {
      throw new DocumentReadProtocolError(
        "invalid_chunk",
        `Invalid document read message: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const accepted = assembler.push(message);
    acceptedMessages += 1;
    if (typeof accepted === "object") result = accepted;
  };

  if (!reader) {
    assertNotAborted(options.signal);
    const text = await response.text();
    receivedBytes = new TextEncoder().encode(text).byteLength;
    peakBufferedTextBytes = receivedBytes;
    for (const line of text.split(/\r?\n/u)) acceptLine(line);
    if (!result) throw missingResult();
    emitDiagnostics(true);
    return result;
  }

  const cancelReader = () => {
    void reader.cancel("document-read-aborted").catch(() => undefined);
  };
  options.signal?.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      assertNotAborted(options.signal);
      const { done, value } = await reader.read();
      assertNotAborted(options.signal);
      if (done) break;
      receivedBytes += value.byteLength;
      bufferedText += decoder.decode(value, { stream: true });
      if (diagnosticsEnabled) {
        peakBufferedTextBytes = Math.max(
          peakBufferedTextBytes,
          new TextEncoder().encode(bufferedText).byteLength,
        );
        peakHeapBytes = maxNullable(peakHeapBytes, sampleHeapBytes());
      }
      let newline = bufferedText.indexOf("\n");
      while (newline >= 0) {
        const line = bufferedText.slice(0, newline).replace(/\r$/u, "");
        bufferedText = bufferedText.slice(newline + 1);
        acceptLine(line);
        newline = bufferedText.indexOf("\n");
      }
      emitDiagnostics(false);
    }
    bufferedText += decoder.decode();
    if (bufferedText) acceptLine(bufferedText.replace(/\r$/u, ""));
    if (!result) throw missingResult();
    emitDiagnostics(true);
    return result;
  } catch (error) {
    if (options.signal?.aborted) throw cancelledError();
    if (error instanceof TypeError && /encoded data|encoding/i.test(error.message)) {
      throw new DocumentReadProtocolError("unsupported_encoding", error.message);
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

export interface CoordinatedDocumentReadOptions {
  readonly consumerId: string;
  readonly documentKey: string;
  readonly signal?: AbortSignal;
  readonly load: (signal: AbortSignal) => Promise<DocumentReadResult>;
}

interface InFlightRead {
  readonly controller: AbortController;
  readonly consumers: Set<string>;
  readonly promise: Promise<DocumentReadResult>;
}

interface ActiveConsumerRead {
  readonly generation: number;
  readonly documentKey: string;
}

export class DocumentReadCoordinator {
  private readonly inFlight = new Map<string, InFlightRead>();
  private readonly activeByConsumer = new Map<string, ActiveConsumerRead>();
  private readonly latestByConsumer = new Map<string, DocumentReadResult>();
  private generation = 0;

  read(options: CoordinatedDocumentReadOptions): Promise<DocumentReadResult> {
    if (options.signal?.aborted) return Promise.reject(cancelledError());
    const generation = ++this.generation;
    this.detachConsumer(options.consumerId);
    this.activeByConsumer.set(options.consumerId, { generation, documentKey: options.documentKey });

    let flight = this.inFlight.get(options.documentKey);
    if (!flight) {
      const controller = new AbortController();
      const promise = Promise.resolve()
        .then(() => options.load(controller.signal))
        .finally(() => {
          if (this.inFlight.get(options.documentKey)?.promise === promise) {
            this.inFlight.delete(options.documentKey);
          }
        });
      flight = { controller, consumers: new Set(), promise };
      this.inFlight.set(options.documentKey, flight);
    }
    flight.consumers.add(options.consumerId);

    return new Promise<DocumentReadResult>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        callback();
        this.detachConsumer(options.consumerId, generation);
      };
      const onAbort = () => finish(() => reject(cancelledError()));
      options.signal?.addEventListener("abort", onAbort, { once: true });

      flight?.promise.then(
        (result) => finish(() => {
          if (!this.isCurrent(options.consumerId, generation, options.documentKey)) {
            reject(cancelledError());
            return;
          }
          this.latestByConsumer.set(options.consumerId, result);
          resolve(result);
        }),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  latest(consumerId: string): DocumentReadResult | null {
    return this.latestByConsumer.get(consumerId) ?? null;
  }

  release(consumerId: string): void {
    this.detachConsumer(consumerId);
    this.latestByConsumer.delete(consumerId);
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  private isCurrent(consumerId: string, generation: number, documentKey: string): boolean {
    const active = this.activeByConsumer.get(consumerId);
    return active?.generation === generation && active.documentKey === documentKey;
  }

  private detachConsumer(consumerId: string, generation?: number): void {
    const active = this.activeByConsumer.get(consumerId);
    if (!active || (generation !== undefined && active.generation !== generation)) return;
    this.activeByConsumer.delete(consumerId);
    const flight = this.inFlight.get(active.documentKey);
    flight?.consumers.delete(consumerId);
    if (flight && flight.consumers.size === 0) {
      flight.controller.abort();
      this.inFlight.delete(active.documentKey);
    }
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

function cancelledError(): DocumentReadProtocolError {
  return new DocumentReadProtocolError("cancelled", "Document preview read cancelled", true);
}

function missingResult(): DocumentReadProtocolError {
  return new DocumentReadProtocolError(
    "missing_chunks",
    "Document stream ended without a complete result",
    true,
  );
}

function sampleHeapBytes(): number | null {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  }).memory;
  return typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null;
}

function maxNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}
