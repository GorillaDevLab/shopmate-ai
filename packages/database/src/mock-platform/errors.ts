export type SourceErrorCode =
  | "SOURCE_INPUT"
  | "SOURCE_CONFIGURATION"
  | "SOURCE_CREDENTIALS"
  | "SOURCE_STORAGE"
  | "SOURCE_INTEGRITY";
export class SourceStorageError extends Error {
  constructor(readonly code: SourceErrorCode) {
    super(code);
    this.name = "SourceStorageError";
  }
}
export function sanitized(error: unknown): SourceStorageError {
  return error instanceof SourceStorageError ? error : new SourceStorageError("SOURCE_STORAGE");
}
