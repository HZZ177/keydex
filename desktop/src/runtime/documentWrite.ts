export const DOCUMENT_WRITE_PROTOCOL_VERSION = "document-write/v1";

export interface DocumentWriteRequest {
  readonly protocol_version: typeof DOCUMENT_WRITE_PROTOCOL_VERSION;
  readonly path: string;
  readonly content: string;
  readonly expected_revision: string;
}

export interface DocumentWriteResult {
  readonly protocol_version: typeof DOCUMENT_WRITE_PROTOCOL_VERSION;
  readonly path: string;
  readonly revision: string;
  readonly encoding: "utf-8";
  readonly total_bytes: number;
}

export function createDocumentWriteRequest(
  path: string,
  content: string,
  expectedRevision: string,
): DocumentWriteRequest {
  return Object.freeze({
    protocol_version: DOCUMENT_WRITE_PROTOCOL_VERSION,
    path,
    content,
    expected_revision: expectedRevision,
  });
}
