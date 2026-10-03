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
// Internal signal is preserved only after transaction rollback, never a public error code.
export class SourceAccessDenied extends Error {}
export function isGuardDenial(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "SM001";
}
export function sanitized(error: unknown): SourceStorageError {
  return error instanceof SourceStorageError ? error : new SourceStorageError("SOURCE_STORAGE");
}
