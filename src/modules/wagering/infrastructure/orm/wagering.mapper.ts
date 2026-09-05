import { Money } from '@shared/domain/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@modules/wagering/domain/wager-transaction';
import { WalletLedgerEntry, LedgerDirection } from '@modules/wagering/domain/wallet-ledger-entry';
import { FailureCode } from '@shared/domain/failure-codes';
import { WagerTransactionOrmEntity } from './wager-transaction.orm-entity';
import { WalletLedgerEntryOrmEntity } from './wallet-ledger-entry.orm-entity';

export class WagerTransactionMapper {
  static toOrm(tx: WagerTransaction, existing?: WagerTransactionOrmEntity): WagerTransactionOrmEntity {
    const orm = existing ?? new WagerTransactionOrmEntity();
    orm.id = tx.id;
    orm.providerId = tx.providerId;
    orm.externalTransactionId = tx.externalTransactionId;
    orm.idempotencyKey = tx.idempotencyKey;
    orm.payloadHash = tx.payloadHash;
    orm.walletId = tx.walletId;
    orm.playerId = tx.playerId;
    orm.roundId = tx.roundId;
    orm.gameId = tx.gameId;
    orm.kind = tx.kind;
    orm.amount = tx.money.toDecimalString();
    orm.currency = tx.money.currency;
    orm.referenceExternalTransactionId = tx.referenceExternalTransactionId;
    orm.referenceTransactionId = tx.referenceTransactionId;
    orm.createdAt = tx.createdAt;
    orm.status = tx.status;
    orm.failureCode = tx.failureCode;
    orm.processedAt = tx.processedAt;
    orm.attempts = tx.attempts;
    if (tx.status === WagerTransactionStatus.PendingReference) {
      // backoff exponencial com jitter, calculado pelo caso de uso/worker de
      // reprocessamento; aqui apenas persistimos o campo já calculado.
    }
    return orm;
  }

  static toDomain(orm: WagerTransactionOrmEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: orm.id,
      providerId: orm.providerId,
      externalTransactionId: orm.externalTransactionId,
      idempotencyKey: orm.idempotencyKey,
      payloadHash: orm.payloadHash,
      walletId: orm.walletId,
      playerId: orm.playerId,
      roundId: orm.roundId,
      gameId: orm.gameId,
      kind: orm.kind as WagerTransactionKind,
      money: { amount: orm.amount, currency: orm.currency },
      referenceExternalTransactionId: orm.referenceExternalTransactionId,
      createdAt: orm.createdAt,
      status: orm.status as WagerTransactionStatus,
      referenceTransactionId: orm.referenceTransactionId,
      failureCode: orm.failureCode as FailureCode | undefined,
      processedAt: orm.processedAt,
      attempts: orm.attempts,
    });
  }
}

export class WalletLedgerEntryMapper {
  static toOrm(entry: WalletLedgerEntry): WalletLedgerEntryOrmEntity {
    const orm = new WalletLedgerEntryOrmEntity();
    orm.id = entry.id;
    orm.walletId = entry.walletId;
    orm.transactionId = entry.transactionId;
    orm.direction = entry.direction;
    orm.amount = entry.money.toDecimalString();
    orm.currency = entry.money.currency;
    orm.balanceBefore = entry.balanceBefore.toDecimalString();
    orm.balanceAfter = entry.balanceAfter.toDecimalString();
    orm.createdAt = entry.createdAt;
    return orm;
  }

  static toDomain(orm: WalletLedgerEntryOrmEntity): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: orm.id,
      walletId: orm.walletId,
      transactionId: orm.transactionId,
      direction: orm.direction as LedgerDirection,
      money: { amount: orm.amount, currency: orm.currency },
      balanceBefore: { amount: orm.balanceBefore, currency: orm.currency },
      balanceAfter: { amount: orm.balanceAfter, currency: orm.currency },
      createdAt: orm.createdAt,
    });
  }
}

/** Recalcula o saldo teórico a partir do ledger — usado pela reconciliação (§9). */
export function sumLedgerToBalance(entries: WalletLedgerEntry[], currency: string): Money {
  return entries.reduce((acc, e) => (e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money)), Money.zero(currency));
}
