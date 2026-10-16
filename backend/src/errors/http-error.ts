/** Error with an HTTP status code that is safe to expose to the client. */
export class HttpError extends Error {
  readonly statusCode: number;
  /** Optional stable code for business rules the client explains in its own words (e.g. INSUFFICIENT_STOCK). */
  readonly code?: string;

  constructor(statusCode: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}
