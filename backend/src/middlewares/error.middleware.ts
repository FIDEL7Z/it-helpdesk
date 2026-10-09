import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { ZodError, z } from 'zod';
import { HttpError } from '../errors/http-error';

function hasProperty<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return typeof value === 'object' && value !== null && key in value;
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ message: 'Route not found' });
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.statusCode).json({ message: error.message });
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({
      message: 'Invalid request data',
      errors: z.flattenError(error).fieldErrors,
    });
    return;
  }

  // Thrown by express.json() when the body is not valid JSON.
  if (hasProperty(error, 'type') && error.type === 'entity.parse.failed') {
    res.status(400).json({ message: 'Malformed JSON body' });
    return;
  }

  // Safety net: request data is validated with Zod first, so these should not normally happen.
  if (error instanceof mongoose.Error.CastError) {
    res.status(400).json({ message: 'Invalid identifier' });
    return;
  }

  if (error instanceof mongoose.Error.ValidationError) {
    res.status(400).json({ message: 'Invalid data' });
    return;
  }

  // MongoDB unique index violation (e.g. duplicated email).
  if (hasProperty(error, 'code') && error.code === 11000) {
    res.status(409).json({ message: 'Resource already exists' });
    return;
  }

  console.error(error);
  res.status(500).json({ message: 'Internal server error' });
};
