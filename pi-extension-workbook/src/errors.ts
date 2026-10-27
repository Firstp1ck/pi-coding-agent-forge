export type WorkbookErrorCode =
  | "ABORTED"
  | "AUTHORIZATION_REQUIRED"
  | "BACKEND_UNAVAILABLE"
  | "CONFLICT"
  | "ENCRYPTED_PACKAGE"
  | "INVALID_ARGUMENT"
  | "INVALID_PACKAGE"
  | "LIMIT_EXCEEDED"
  | "LOSSY_OPERATION"
  | "NOT_FOUND"
  | "OUTPUT_EXISTS"
  | "PASSWORD_REQUIRED"
  | "UNSUPPORTED_FEATURE"
  | "VALIDATION_FAILED";

export class WorkbookError extends Error {
  readonly code: WorkbookErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: WorkbookErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "WorkbookError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code: WorkbookErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new WorkbookError(code, message, details);
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) fail("ABORTED", "Workbook operation was cancelled.");
}

export function errorDetails(error: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  if (error instanceof WorkbookError) {
    return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  }
  return { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
}
