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

export function toErrorResult(error: unknown): { success: false; error: string; code: string; details?: unknown; next?: string[] } {
  if (error instanceof TeditError) {
    const next = nextHints(error.details);
    return {
      success: false,
      error: error.message,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(next && next.length > 0 ? { next } : {}),
    };
  }

  if (error instanceof Error) {
    return { success: false, error: error.message, code: "UNEXPECTED_ERROR" };
  }

  return { success: false, error: String(error), code: "UNEXPECTED_ERROR" };
}

function nextHints(details: unknown): string[] | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const record = details as Record<string, unknown>;
  if (Array.isArray(record.next) && record.next.every((item) => typeof item === "string")) {
    return record.next.slice(0, 3);
  }
  if (typeof record.next_step_hint === "string") return [record.next_step_hint];
  if (Array.isArray(record.suggestions) && record.suggestions.every((item) => typeof item === "string")) {
    return record.suggestions.slice(0, 3);
  }
  return nextHints(record.cause);
}
