import type { BrowserSurfaceRef } from "../../domain";

const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;

export type IncognitoCaptureInvoke = (
  command: string,
  args: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

export interface TakeIncognitoCaptureInput {
  readonly surface: BrowserSurfaceRef;
  readonly captureRequestId: string;
  readonly assetId: string;
}

export async function takeIncognitoCaptureBlob(
  input: TakeIncognitoCaptureInput,
  invoke?: IncognitoCaptureInvoke,
): Promise<Blob> {
  const call = invoke ?? await loadTauriInvoke();
  const raw = await call("browser_take_incognito_capture", {
    payload: {
      ...input.surface,
      captureRequestId: input.captureRequestId,
      assetId: input.assetId,
    },
  });
  const payload = parseTakenCapture(raw, input.assetId);
  const bytes = decodeBase64(payload.dataBase64);
  if (bytes.byteLength !== payload.byteLength || bytes.byteLength > MAX_CAPTURE_BYTES) {
    throw new Error("无痕区域截图大小校验失败");
  }
  if (await sha256Hex(bytes) !== payload.sha256) {
    throw new Error("无痕区域截图完整性校验失败");
  }
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([buffer], { type: payload.mimeType });
}

interface TakenCapturePayload {
  readonly assetId: string;
  readonly mimeType: "image/png";
  readonly byteLength: number;
  readonly sha256: string;
  readonly dataBase64: string;
}

function parseTakenCapture(value: unknown, expectedAssetId: string): TakenCapturePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("无痕区域截图返回格式无效");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join("\u0000") !== ["assetId", "byteLength", "dataBase64", "mimeType", "sha256"].sort().join("\u0000")) {
    throw new Error("无痕区域截图返回字段无效");
  }
  if (
    record.assetId !== expectedAssetId
    || record.mimeType !== "image/png"
    || typeof record.byteLength !== "number"
    || !Number.isInteger(record.byteLength)
    || record.byteLength <= 0
    || record.byteLength > MAX_CAPTURE_BYTES
    || typeof record.sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.sha256)
    || typeof record.dataBase64 !== "string"
    || !record.dataBase64
  ) {
    throw new Error("无痕区域截图返回内容无效");
  }
  return record as unknown as TakenCapturePayload;
}

function decodeBase64(value: string): Uint8Array {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new Error("无痕区域截图编码无效");
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("无法校验无痕区域截图");
  const digest = await subtle.digest("SHA-256", value.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}

async function loadTauriInvoke(): Promise<IncognitoCaptureInvoke> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke as unknown as IncognitoCaptureInvoke;
}
