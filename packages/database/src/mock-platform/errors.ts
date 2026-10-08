export type SourceErrorCode =
  | "SOURCE_INPUT"
  | "SOURCE_ABORTED"
  | "SOURCE_DEADLINE"
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
export type SourceFailureStatus = "DENIED" | "FENCED" | "CONFLICT";
export class SourceDomainFailure extends Error {
  constructor(readonly status: SourceFailureStatus) {
    super(status);
    this.name = "SourceDomainFailure";
  }
}
// Internal signals are preserved only after transaction rollback, never as public error codes.
export class SourceAccessDenied extends SourceDomainFailure {
  constructor() {
    super("DENIED");
    this.name = "SourceAccessDenied";
  }
}
function sqlState(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
function domainStatus(code: unknown): SourceFailureStatus | undefined {
  if (code === "SM001") return "DENIED";
  if (code === "SM003") return "FENCED";
  if (code === "SM004") return "CONFLICT";
  return undefined;
}
export function transactionFailure(error: unknown, allowed: readonly SourceFailureStatus[]): Error {
  if (error instanceof SourceDomainFailure)
    return allowed.includes(error.status) ? error : new SourceStorageError("SOURCE_STORAGE");
  if (sqlState(error) === "SM005") return new SourceStorageError("SOURCE_INTEGRITY");
  const status = domainStatus(sqlState(error));
  if (!status || !allowed.includes(status)) return sanitized(error);
  return status === "DENIED" ? new SourceAccessDenied() : new SourceDomainFailure(status);
}
export function sanitized(error: unknown): SourceStorageError {
  return error instanceof SourceStorageError ? error : new SourceStorageError("SOURCE_STORAGE");
}
