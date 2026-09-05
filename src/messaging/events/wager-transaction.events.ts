import { v7 as uuidv7 } from 'uuid';
import { IntegrationEvent, EventContext } from '@shared/kernel/integration-event';
import { MoneyProps } from '@shared/domain/money';
import { WagerTransaction } from '@modules/wagering/domain/wager-transaction';

interface BaseTransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
}

export interface WagerTransactionProcessedData extends BaseTransactionData {
  status: 'PROCESSED';
  referenceTransactionId?: string;
  balanceAfter?: MoneyProps;
}

/** Emitido para QUALQUER transação aplicada, inclusive LOSS (que não move saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext, balanceAfter?: MoneyProps): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: uuidv7(),
      aggregateId: tx.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: new Date(),
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        status: 'PROCESSED',
        ...(tx.referenceTransactionId !== undefined ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        ...(balanceAfter !== undefined ? { balanceAfter } : {}),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends BaseTransactionData {
  status: 'REJECTED';
  failureCode: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      eventId: uuidv7(),
      aggregateId: tx.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: new Date(),
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        status: 'REJECTED',
        failureCode: tx.failureCode ?? 'UNKNOWN',
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends BaseTransactionData {
  status: 'PENDING_REFERENCE';
  referenceExternalTransactionId: string;
  attempts: number;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId: uuidv7(),
      aggregateId: tx.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: new Date(),
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        status: 'PENDING_REFERENCE',
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? '',
        attempts: tx.attempts,
      },
    });
  }
}
