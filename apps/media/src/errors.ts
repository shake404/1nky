/**
 * Error type for the media service.
 *
 * Carries an HTTP status and a short, human-readable reason. The reason is
 * safe to echo back to the client (it never contains request metadata) and is
 * also emitted as the Blossom `X-Reason` header.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}
