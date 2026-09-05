import { createHash } from 'node:crypto';

/**
 * payloadHash = SHA-256 hex do JSON canônico (chaves ordenadas
 * recursivamente, sem espaços) do SUBCONJUNTO DE CAMPOS DE NEGÓCIO da
 * requisição. Nunca inclui o header Idempotency-Key, messageId do SQS,
 * timestamps de transporte (occurredAt do envelope) ou qualquer metadado
 * de entrega — apenas o que descreve "qual operação é esta".
 *
 * Campos incluídos (nesta ordem irrelevante, pois são ordenados):
 * providerId, externalTransactionId, playerId, walletId, roundId, gameId,
 * kind, money.amount, money.currency, referenceExternalTransactionId.
 */
export interface HashableWagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string | undefined;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function computeWagerPayloadHash(payload: HashableWagerPayload): string {
  const canonical = canonicalize({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
  });
  const json = JSON.stringify(canonical);
  return createHash('sha256').update(json).digest('hex');
}
