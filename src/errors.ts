import { ZodError } from 'zod';

export class ApplicationError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConcurrentRunError extends ApplicationError {
  constructor() {
    super('worker_busy', 409, 'The digest worker is already running');
  }
}

export class StoryNotFoundError extends ApplicationError {
  constructor() {
    super('story_not_found', 404, 'The Hacker News story was not found');
  }
}

export class UnreadableStoryError extends ApplicationError {
  constructor(message = 'The Hacker News story has no readable source material') {
    super('story_unreadable', 422, message);
  }
}

export class PublicationConflictError extends ApplicationError {
  constructor(message: string) {
    super('publication_conflict', 409, message);
  }
}

export class RemoteHttpError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(`${service}: HTTP ${status}`);
    this.name = 'RemoteHttpError';
  }
}

export class DeliveryRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryRejectedError';
  }
}

export class DeliveryUncertainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeliveryUncertainError';
  }
}

export function errorCode(error: unknown): string {
  if (error instanceof ApplicationError) return error.code;
  if (error instanceof RemoteHttpError) return `${error.service}_http_${error.status}`;
  if (error instanceof ZodError) return 'invalid_remote_data';
  if (error instanceof Error) return error.name;
  return 'unknown_error';
}

export function errorStatus(error: unknown): number {
  return error instanceof ApplicationError ? error.status : 500;
}
