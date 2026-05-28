export class TeditError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "TeditError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code: string, message: string, details?: unknown): never {
  throw new TeditError(code, message, details);
}

export function toErrorResult(error: unknown): { success: false; error: string; code: string; details?: unknown } {
  if (error instanceof TeditError) {
    return {
      success: false,
      error: error.message,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }

  if (error instanceof Error) {
    return { success: false, error: error.message, code: "UNEXPECTED_ERROR" };
  }

  return { success: false, error: String(error), code: "UNEXPECTED_ERROR" };
}

