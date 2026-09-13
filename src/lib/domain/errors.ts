export type DomainErrorCode =
  | "forbidden"
  | "not_found"
  | "invalid"
  | "conflict"
  | "paused"
  | "limit_reached"
  | "gate_quarantined";

/**
 * Errors the domain layer raises on purpose. Anything else escaping a service
 * is a bug or an infrastructure failure and is reported as such.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function isDomainError(error: unknown, code?: DomainErrorCode): error is DomainError {
  return error instanceof DomainError && (code === undefined || error.code === code);
}

/** PostgreSQL unique violation, used to turn races into idempotent results. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "23505"
  );
}
