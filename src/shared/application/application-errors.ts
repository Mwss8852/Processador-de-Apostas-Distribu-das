import { FailureCode } from '@shared/domain/failure-codes';

/** Payload inválido — deve mapear para HTTP 422. */
export class InvalidPayloadError extends Error {
  constructor(
    message: string,
    public readonly failureCode: FailureCode = FailureCode.InvalidPayload,
  ) {
    super(message);
    this.name = 'InvalidPayloadError';
  }
}

/** Mesma Idempotency-Key, payload de negócio diferente — HTTP 409, FailureCode.IdempotencyPayloadConflict. */
export class IdempotencyConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(`Idempotency-Key "${idempotencyKey}" was already used with a different payload`);
    this.name = 'IdempotencyConflictError';
  }
}

/** Recurso referenciado não existe (ex.: walletId) — HTTP 404. */
export class NotFoundError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} "${id}" not found`);
    this.name = 'NotFoundError';
  }
}

/** Conflito de criação (ex.: carteira duplicada playerId+currency) — HTTP 409. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** Falha transitória de infraestrutura (DB/SQS indisponível, lock timeout) — HTTP 503, RETRY_SAFE. */
export class TransientInfrastructureError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'TransientInfrastructureError';
  }
}
