import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { requestContext } from './request-context';

/** Application error with a stable machine-readable code (clients branch on `code`, not text). */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const Errors = {
  badRequest: (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details),
  validation: (details: unknown) => new AppError(400, 'VALIDATION_FAILED', 'Request validation failed', details),
  unauthenticated: (message = 'Authentication required') => new AppError(401, 'UNAUTHENTICATED', message),
  forbidden: (message = 'You do not have permission to perform this action', code = 'FORBIDDEN') =>
    new AppError(403, code, message),
  notFound: (entity = 'Resource') => new AppError(404, 'NOT_FOUND', `${entity} not found`),
  conflict: (code: string, message: string, details?: unknown) => new AppError(409, code, message, details),
  invalidState: (message: string, details?: unknown) => new AppError(409, 'INVALID_STATE_TRANSITION', message, details),
  unprocessable: (code: string, message: string, details?: unknown) => new AppError(422, code, message, details),
  tooMany: (message = 'Too many requests') => new AppError(429, 'RATE_LIMITED', message),
  unavailable: (message = 'Service temporarily unavailable') => new AppError(503, 'SERVICE_UNAVAILABLE', message),
};

interface PgError { code?: string; constraint?: string; detail?: string; message: string }

/** Maps PostgreSQL errors to safe API errors; never leaks SQL or row contents. */
export function mapPgError(err: PgError): AppError | null {
  switch (err.code) {
    case '23514':
      if (err.constraint?.startsWith('inventory_')) {
        return Errors.conflict('INSUFFICIENT_STOCK', 'The stock change would make a quantity negative or exceed available stock', { constraint: err.constraint });
      }
      return Errors.conflict('CONSTRAINT_VIOLATION', 'The change violates a data integrity rule', { constraint: err.constraint });
    case '23505':
      return Errors.conflict('DUPLICATE', 'A record with the same unique values already exists', { constraint: err.constraint });
    case '23503':
      return Errors.unprocessable('INVALID_REFERENCE', 'A referenced record does not exist', { constraint: err.constraint });
    case '22P02':
    case '22007':
    case '22008':
      return Errors.badRequest('Malformed value in request');
    case '40001':
    case '40P01':
      return new AppError(503, 'CONCURRENT_UPDATE_RETRY', 'Concurrent update detected; please retry');
    case '57014':
      return Errors.unavailable('The operation timed out');
    case '08006':
    case '08001':
    case '57P01':
      return Errors.unavailable('Database unavailable');
    default:
      return null;
  }
}

/** body-parser / http-errors client errors (e.g. payload too large, invalid JSON). */
function isBodyParserError(e: unknown): boolean {
  const x = e as { status?: unknown; expose?: unknown; type?: unknown };
  return !!x && typeof x === 'object' && typeof x.status === 'number' && x.status >= 400 && x.status < 500 && x.expose === true;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = requestContext.get()?.requestId;
    let appErr: AppError;

    if (exception instanceof AppError) {
      appErr = exception;
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = status === 429 ? 'RATE_LIMITED' : status === 404 ? 'NOT_FOUND' : status === 413 ? 'PAYLOAD_TOO_LARGE' : `HTTP_${status}`;
      const body = exception.getResponse();
      const message = typeof body === 'string' ? body : (body as { message?: string }).message ?? exception.message;
      appErr = new AppError(status, code, Array.isArray(message) ? message.join('; ') : String(message));
    } else if (isBodyParserError(exception)) {
      const e = exception as { status: number; type?: string };
      appErr = e.type === 'entity.too.large'
        ? new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large')
        : new AppError(400, 'MALFORMED_REQUEST', 'Malformed request body');
    } else if (exception && typeof exception === 'object' && 'code' in exception && mapPgError(exception as PgError)) {
      appErr = mapPgError(exception as PgError)!;
    } else if ((exception as { code?: string })?.code === 'ECONNREFUSED') {
      appErr = Errors.unavailable('Database unavailable');
    } else {
      appErr = new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    }

    if (appErr.status >= 500) {
      this.logger.error({ err: exception, requestId, code: appErr.code }, 'request failed');
    }
    res.status(appErr.status).json({
      error: { code: appErr.code, message: appErr.message, details: appErr.details, requestId },
    });
  }
}
