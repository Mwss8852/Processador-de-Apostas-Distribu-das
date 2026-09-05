import { v7 as uuidv7 } from 'uuid';
import { FailureCode } from '@shared/domain/failure-codes';
import { computeBackoff } from '@shared/application/backoff';
import { WageringUnitOfWork } from './ports/wagering-unit-of-work';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus, LedgerDirection } from '../domain/wager-transaction';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '@messaging/events/wager-transaction.events';
import { WalletBalanceChanged } from '@messaging/events/wallet-balance-changed.event';
import { InsufficientBalanceError, NegativeBalanceGuardError } from '@shared/domain/errors';

/** Limite de esforço antes de rejeitar definitivamente por referência ausente.
 * Justificativa (ARCHITECTURE.md §8): 8 tentativas com backoff exponencial
 * (base 2s, cap 5min) cobrem ~15-20 minutos de espera — tempo generoso para
 * que uma operação fora de ordem (ex.: REFUND que chegou antes do BET por
 * reordenamento do SQS) se resolva, sem manter transações PENDING_REFERENCE
 * indefinidamente. */
const MAX_ATTEMPTS = 8;

export class ProcessPendingReferencesUseCase {
  constructor(private readonly uow: WageringUnitOfWork) {}

  /** Processa um lote; retorna quantas transações mudaram de estado. */
  async executeBatch(batchSize = 100): Promise<number> {
    let processed = 0;
    // Cada transação candidata é reprocessada em sua PRÓPRIA transação SQL,
    // para que uma falha em uma não aborte as demais do lote.
    const due = await this.uow.run(async (scope) => scope.transactions.findDuePendingReference(new Date(), batchSize));

    for (const pending of due) {
      await this.reprocessOne(pending.id);
      processed += 1;
    }
    return processed;
  }

  private async reprocessOne(transactionId: string): Promise<void> {
    await this.uow.run(async (scope) => {
      const tx = await scope.transactions.findById(transactionId);
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) return; // já resolvida por outro worker

      const ctx = { correlationId: uuidv7() };
      const reference = await scope.transactions.findReference(tx.providerId, tx.referenceExternalTransactionId!);

      if (!reference) {
        if (tx.attempts >= MAX_ATTEMPTS) {
          tx.reject(FailureCode.ReferenceNotFoundTimeout);
          await scope.transactions.save(tx);
          await scope.outbox.enqueue(WagerTransactionRejected.from(tx, ctx));
        } else {
          tx.markPendingReference(); // incrementa attempts
          await scope.transactions.save(tx);
          await scope.transactions.scheduleNextAttempt(tx.id, computeBackoff(tx.attempts));
        }
        return;
      }

      if (!tx.isValidReferenceKind(reference)) {
        tx.reject(FailureCode.InvalidReferenceKind);
        await scope.transactions.save(tx);
        await scope.outbox.enqueue(WagerTransactionRejected.from(tx, ctx));
        return;
      }
      if (reference.status !== WagerTransactionStatus.Processed) {
        tx.reject(FailureCode.ReferenceNotTerminalProcessed);
        await scope.transactions.save(tx);
        await scope.outbox.enqueue(WagerTransactionRejected.from(tx, ctx));
        return;
      }
      if (reference.playerId !== tx.playerId || reference.walletId !== tx.walletId || reference.roundId !== tx.roundId) {
        tx.reject(FailureCode.ReferenceMismatch);
        await scope.transactions.save(tx);
        await scope.outbox.enqueue(WagerTransactionRejected.from(tx, ctx));
        return;
      }
      if (!reference.money.equals(tx.money)) {
        tx.reject(FailureCode.ReferenceAmountMismatch);
        await scope.transactions.save(tx);
        await scope.outbox.enqueue(WagerTransactionRejected.from(tx, ctx));
        return;
      }
      const reversals = await scope.transactions.countByReferenceAndKind(reference.id, tx.kind);
      if (reversals > 0) {
        tx.reject(FailureCode.ReferenceAlreadyReversed);
        await scope.transactions.save(tx);
        await scope.outbox.enqueue(WagerTransactionRejected.from(tx, ctx));
        return;
      }

      const wallet = await scope.wallets.findByIdForUpdate(tx.walletId);
      if (!wallet) return; // não deveria acontecer; próxima rodada tenta de novo

      try {
        const direction = tx.kind === WagerTransactionKind.Refund ? LedgerDirection.Credit : tx.ledgerDirectionFor(reference);
        const mutation = direction === LedgerDirection.Credit ? wallet.credit(tx.money) : wallet.debit(tx.money, { guardOnly: true });
        const entry = WalletLedgerEntry.create({
          id: uuidv7(),
          walletId: wallet.id,
          transactionId: tx.id,
          direction,
          money: tx.money,
          balanceBefore: mutation.balanceBefore,
          balanceAfter: mutation.balanceAfter,
        });
        await scope.ledger.insert(entry);
        await scope.wallets.save(wallet);
        tx.markProcessed(reference.id, new Date());
        await scope.transactions.save(tx);
        await scope.outbox.enqueue(WalletBalanceChanged.from(wallet, entry, ctx));
        await scope.outbox.enqueue(WagerTransactionProcessed.from(tx, ctx, wallet.balance.toJSON()));
      } catch (err) {
        if (err instanceof InsufficientBalanceError) {
          tx.reject(FailureCode.InsufficientBalance);
        } else if (err instanceof NegativeBalanceGuardError) {
          tx.reject(FailureCode.NegativeBalanceGuard);
        } else {
          throw err;
        }
        await scope.transactions.save(tx);
        await scope.outbox.enqueue(WagerTransactionRejected.from(tx, ctx));
      }
    });
  }
}
