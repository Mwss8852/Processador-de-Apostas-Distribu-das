import { HttpException, HttpStatus } from '@nestjs/common';
import {
  ConflictError,
  IdempotencyConflictError,
  InvalidPayloadError,
  NotFoundError,
  TransientInfrastructureError,
} from '@shared/application/application-errors';
import { InvalidMoneyError, MoneyCurrencyMismatchError } from '@shared/domain/money';
import { FAILURE_CATEGORY, FailureCode } from '@shared/domain/failure-codes';

/**
 * Mapeamento único e consistente entre todos os endpoints (seção 9):
 *   404 Not Found                -> recurso inexistente (ex.: walletId)
 *   422 Unprocessable Entity     -> payload inválido (FIX_AND_RETRY)
 *   409 Conflict                 -> conflito de idempotência OU de criação
 *   200/201 com status REJECTED  -> excluído por regra de negócio
 *                                    (a transação existe e é auditável —
 *                                    não é um erro HTTP, é uma decisão)
 *   200/201 com status PENDING_REFERENCE -> aceito, processamento pendente
 *   503 Service Unavailable      -> falha transitória de infraestrutura
 * Isso permite ao provedor decidir com base APENAS no status HTTP + no
 * failureCode do corpo, sem precisar fazer parsing de mensagem de erro.
 */
export function toHttpException(err: unknown): HttpException {
  if (err instanceof NotFoundError) {
    return new HttpException({ message: err.message, failureCode: 'NOT_FOUND' }, HttpStatus.NOT_FOUND);
  }
  if (err instanceof ConflictError) {
    return new HttpException({ message: err.message, failureCode: 'CONFLICT' }, HttpStatus.CONFLICT);
  }
  if (err instanceof IdempotencyConflictError) {
    return new HttpException(
      { message: err.message, failureCode: FailureCode.IdempotencyPayloadConflict },
      HttpStatus.CONFLICT,
    );
  }
  if (err instanceof InvalidPayloadError) {
    return new HttpException({ message: err.message, failureCode: err.failureCode }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
  if (err instanceof InvalidMoneyError || err instanceof MoneyCurrencyMismatchError) {
    return new HttpException(
      { message: err.message, failureCode: FailureCode.InvalidMoney },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  if (err instanceof TransientInfrastructureError) {
    return new HttpException(
      { message: err.message, failureCode: FailureCode.TransientInfrastructureFailure },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
  throw err;
}

export function categoryOf(code: FailureCode): string {
  return FAILURE_CATEGORY[code];
}
