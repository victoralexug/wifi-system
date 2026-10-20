import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Logger } from './logger';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = 'error',
  ) {
    super(message);
  }
}

export const notFound = (message = 'Not found') => new HttpError(404, message, 'not_found');
export const badRequest = (message: string) => new HttpError(400, message, 'bad_request');

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound('Route not found'));

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: { code: 'validation_error', message: 'Invalid request', issues: err.issues },
      });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    // body-parser sets type/status on malformed JSON
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'bad_json', message: 'Malformed JSON body' } });
      return;
    }
    logger.error({ err, path: req.path }, 'unhandled error');
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
  };
}
