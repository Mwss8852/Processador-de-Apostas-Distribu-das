/**
 * Taxonomia de failureCode — estável, legível por máquina, documentada em
 * ARCHITECTURE.md §6. Cada código informa ao provedor se ele deve:
 *   - RETRY_SAFE: reenviar mais tarde (transitório, nada foi decidido ainda)
 *   - FIX_AND_RETRY: corrigir o payload e reenviar (erro do provedor)
 *   - DO_NOT_RETRY: decisão terminal de negócio, reenviar não muda o resultado
 */
export enum FailureCategory {
  RetrySafe = 'RETRY_SAFE',
  FixAndRetry = 'FIX_AND_RETRY',
  DoNotRetry = 'DO_NOT_RETRY',
}

export enum FailureCode {
  // --- Negócio: DO_NOT_RETRY (WagerTransaction -> REJECTED) ---
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  NegativeBalanceGuard = 'NEGATIVE_BALANCE_GUARD', // resultado teria dado negativo por outro motivo que não "aposta sem saldo" (ex.: reversão concorrente)
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND', // ex.: REFUND referenciando um WIN
  ReferenceMismatch = 'REFERENCE_MISMATCH', // referência não pertence ao mesmo provider/player/wallet/currency/round
  ReferenceNotTerminalProcessed = 'REFERENCE_NOT_TERMINAL_PROCESSED',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletMismatch = 'WALLET_MISMATCH', // walletId informado não corresponde ao playerId/currency

  // --- Referência ausente (PENDING_REFERENCE -> reprocessamento; após TTL -> REJECTED) ---
  ReferenceNotFoundTimeout = 'REFERENCE_NOT_FOUND_TIMEOUT',

  // --- Payload/contrato: FIX_AND_RETRY (rejeitado antes de virar WagerTransaction, HTTP 422) ---
  InvalidPayload = 'INVALID_PAYLOAD',
  InvalidMoney = 'INVALID_MONEY',

  // --- Idempotência: DO_NOT_RETRY com o mesmo payload; FIX_AND_RETRY se o payload diverge ---
  IdempotencyPayloadConflict = 'IDEMPOTENCY_PAYLOAD_CONFLICT',

  // --- Infraestrutura: RETRY_SAFE (WagerTransaction -> FAILED, auditável) ---
  TransientInfrastructureFailure = 'TRANSIENT_INFRASTRUCTURE_FAILURE',
  LockAcquisitionTimeout = 'LOCK_ACQUISITION_TIMEOUT',
}

export const FAILURE_CATEGORY: Record<FailureCode, FailureCategory> = {
  [FailureCode.InsufficientBalance]: FailureCategory.DoNotRetry,
  [FailureCode.NegativeBalanceGuard]: FailureCategory.DoNotRetry,
  [FailureCode.ReferenceAlreadyReversed]: FailureCategory.DoNotRetry,
  [FailureCode.InvalidReferenceKind]: FailureCategory.DoNotRetry,
  [FailureCode.ReferenceMismatch]: FailureCategory.DoNotRetry,
  [FailureCode.ReferenceNotTerminalProcessed]: FailureCategory.DoNotRetry,
  [FailureCode.ReferenceAmountMismatch]: FailureCategory.DoNotRetry,
  [FailureCode.CurrencyMismatch]: FailureCategory.DoNotRetry,
  [FailureCode.WalletMismatch]: FailureCategory.DoNotRetry,
  [FailureCode.ReferenceNotFoundTimeout]: FailureCategory.DoNotRetry,
  [FailureCode.InvalidPayload]: FailureCategory.FixAndRetry,
  [FailureCode.InvalidMoney]: FailureCategory.FixAndRetry,
  [FailureCode.IdempotencyPayloadConflict]: FailureCategory.FixAndRetry,
  [FailureCode.TransientInfrastructureFailure]: FailureCategory.RetrySafe,
  [FailureCode.LockAcquisitionTimeout]: FailureCategory.RetrySafe,
};
