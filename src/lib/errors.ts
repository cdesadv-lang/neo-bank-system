export class AppError extends Error {
  constructor(
    public code: string,
    public status: number = 400,
    message?: string,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
}

export const Errors = {
  unauthorized: () => new AppError("UNAUTHORIZED", 401, "Authentication required"),
  forbidden: (m = "You do not have permission for this action") => new AppError("FORBIDDEN", 403, m),
  notFound: (what = "Resource") => new AppError("NOT_FOUND", 404, `${what} not found`),
  validation: (m: string, details?: unknown) => new AppError("VALIDATION_ERROR", 422, m, details),
  conflict: (m: string) => new AppError("CONFLICT", 409, m),
  insufficientFunds: () => new AppError("INSUFFICIENT_FUNDS", 422, "Insufficient funds"),
  rateLimited: () => new AppError("RATE_LIMITED", 429, "Too many requests, try again later"),
};
