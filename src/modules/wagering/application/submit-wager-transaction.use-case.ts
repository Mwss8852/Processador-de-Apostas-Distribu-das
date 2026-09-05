import { v7 as uuidv7 } from 'uuid';
import { Money, MoneyProps } from '@shared/domain/money';
import { FailureCode } from '@shared/domain/failure-codes';
import { computeWagerPayloadHash } from '@shared/application/payload-hash';
import { IdempotencyConflictError, InvalidPayloadError, NotFoundError } from '@shared/application/application-errors';
import { WageringUnitOfWork, WageringUnitOfWorkScope } from './ports/wagering-unit-of-work';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  LedgerDirection,
} from '../domain/wager-transaction';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { InboxMessage } from '@messaging/inbox/inbox-message';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
} from '@messaging/events/wager-transaction.events';
import { WalletBalanceChanged } from '@messaging/events/wallet-balance-changed.event';
import { InsufficientBalanceError, NegativeBalanceGuardError } from '@shared/domain/errors';

export interface InboundMessageInfo {
  consumerName: string;
  messageId: string;
}

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  causationId?: string;
  /** Presente somente quando o comando chega via consumer SQS — habilita a
   * deduplicação por (consumerName, messageId) na mesma transação. */
  inbound?: InboundMessageInfo;
}

export interface SubmitWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

/**
 * Caso de uso único, reutilizado por HTTP (POST /wagering/transactions) e
 * pelo consumer SQS — exigência da seção 10 do desafio. Toda a orquestração
 * roda dentro de UMA transação SQL (WageringUnitOfWork): wager transaction,
 * mutação de saldo, lançamento de ledger, registro de inbox e enfileiramento
 * de outbox commitam juntos ou nada é persistido (seção 11).
 */
export class SubmitWagerTransactionUseCase {
  constructor(private readonly uow: WageringUnitOfWork) {}

  /**
   * Ponto de entrada público. Faz até uma tentativa extra quando a
   * primeira esbarra numa corrida genuína de idempotência: duas
   * submissões concorrentes com a MESMA Idempotency-Key podem ambas
   * passar pela leitura (`findByIdempotencyKey`) antes de qualquer uma
   * commitar — a segunda a tentar `INSERT` perde para o índice único do
   * banco. Quando isso acontece, precisamos diferenciar dois casos:
   *   (a) o payload da corrida é IGUAL ao nosso -> não é conflito de
   *       negócio, é a MESMA operação chegando duas vezes ao mesmo
   *       tempo -> devolvemos o resultado da que venceu, como replay;
   *   (b) o payload é DIFERENTE -> conflito real, propagamos o erro.
   * Sem isso, o comportamento sob concorrência real seria inconsistente
   * com o comportamento sob concorrência sequencial (que já trata (a)
   * corretamente na checagem de leitura do passo 2).
   */
  async execute(cmd: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult> {
    const payloadHash = computeWagerPayloadHash({
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      playerId: cmd.playerId,
      walletId: cmd.walletId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money: Money.fromInput(cmd.money).toJSON(),
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
    });

    try {
      return await this.attempt(cmd, payloadHash);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        // A transação que "venceu" a corrida já commitou (nossa própria
        // tentativa foi revertida junto com o erro). Reabrimos uma nova
        // transação só para LER o resultado e decidir se é replay seguro
        // ou conflito real.
        const resolved = await this.uow.run((scope) => scope.transactions.findByIdempotencyKey(cmd.idempotencyKey));
        if (resolved && resolved.matchesPayload(payloadHash)) {
          return this.uow.run((scope) => this.buildResult(resolved, true, scope, cmd.walletId));
        }
      }
      throw err;
    }
  }

  private async attempt(cmd: SubmitWagerTransactionCommand, payloadHash: string): Promise<SubmitWagerTransactionResult> {
    const money = Money.fromInput(cmd.money);
    const eventCtx = { correlationId: cmd.correlationId, causationId: cmd.causationId };

    return this.uow.run(async (scope) => {
      // ---- 1) Deduplicação de MENSAGEM (nível de transporte) ----------
      if (cmd.inbound) {
        const alreadyReceived = await scope.inbox.findByConsumerAndMessage(cmd.inbound.consumerName, cmd.inbound.messageId);
        if (alreadyReceived) {
          // Esta mensagem específica (mesmo messageId) já foi processada.
          // Não repetimos nenhum efeito colateral: apenas devolvemos o
          // resultado de negócio já existente, para fins de log/ack.
          const existing = await scope.transactions.findByIdempotencyKey(cmd.idempotencyKey);
          return this.buildResult(existing, true, scope, cmd.walletId);
        }
        await scope.inbox.insert(
          InboxMessage.receive({
            messageId: cmd.inbound.messageId,
            consumerName: cmd.inbound.consumerName,
            payloadHash,
          }),
        );
      }

      // ---- 2) Idempotência de NEGÓCIO (Idempotency-Key) ---------------
      const existingByKey = await scope.transactions.findByIdempotencyKey(cmd.idempotencyKey);
      if (existingByKey) {
        if (!existingByKey.matchesPayload(payloadHash)) {
          throw new IdempotencyConflictError(cmd.idempotencyKey);
        }
        return this.buildResult(existingByKey, true, scope, cmd.walletId);
      }

      // ---- 3) Validação básica de payload ------------------------------
      if (cmd.kind === WagerTransactionKind.Opening) {
        throw new InvalidPayloadError('OPENING cannot be submitted through this endpoint');
      }

      const tx = WagerTransaction.create({
        id: uuidv7(),
        providerId: cmd.providerId,
        externalTransactionId: cmd.externalTransactionId,
        idempotencyKey: cmd.idempotencyKey,
        payloadHash,
        walletId: cmd.walletId,
        playerId: cmd.playerId,
        roundId: cmd.roundId,
        gameId: cmd.gameId,
        kind: cmd.kind,
        money,
        referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      });

      // ---- 4) Trava a carteira (unidade de concorrência) ---------------
      const wallet = await scope.wallets.findByIdForUpdate(cmd.walletId);
      if (!wallet) {
        throw new NotFoundError('Wallet', cmd.walletId);
      }
      if (wallet.playerId !== cmd.playerId) {
        tx.reject(FailureCode.WalletMismatch);
        await this.persistTerminal(scope, tx, eventCtx);
        return this.buildResult(tx, false, scope, cmd.walletId);
      }
      if (wallet.currency !== money.currency) {
        tx.reject(FailureCode.CurrencyMismatch);
        await this.persistTerminal(scope, tx, eventCtx);
        return this.buildResult(tx, false, scope, cmd.walletId);
      }

      // ---- 5) Resolve referência para REFUND/ROLLBACK ------------------
      let reference: WagerTransaction | undefined;
      if (tx.requiresReference()) {
        const found = await scope.transactions.findReference(cmd.providerId, cmd.referenceExternalTransactionId!);
        if (!found) {
          // Sem backoff na primeira vez: a referência pode chegar a
          // qualquer momento (é um reordenamento, não uma ausência
          // permanente) — o worker de reprocessamento já a pega na
          // próxima rodada. Backoff exponencial só se aplica a partir da
          // SEGUNDA tentativa sem sucesso (ver ProcessPendingReferencesUseCase).
          tx.markPendingReference();
          await scope.transactions.insert(tx);
          await scope.outbox.enqueue(WagerTransactionPendingReference.from(tx, eventCtx));
          return this.buildResult(tx, false, scope, cmd.walletId);
        }
        reference = found;

        const rejection = this.validateReference(tx, reference, money);
        if (rejection) {
          tx.reject(rejection);
          await this.persistTerminal(scope, tx, eventCtx);
          return this.buildResult(tx, false, scope, cmd.walletId);
        }

        const reversalCount = await scope.transactions.countByReferenceAndKind(reference.id, tx.kind);
        if (reversalCount > 0) {
          tx.reject(FailureCode.ReferenceAlreadyReversed);
          await this.persistTerminal(scope, tx, eventCtx);
          return this.buildResult(tx, false, scope, cmd.walletId);
        }
      }

      // ---- 6) Aplica a movimentação de saldo ---------------------------
      let ledgerEntry: WalletLedgerEntry | undefined;
      try {
        if (tx.kind === WagerTransactionKind.Bet) {
          const mutation = wallet.debit(money);
          ledgerEntry = WalletLedgerEntry.create({
            id: uuidv7(),
            walletId: wallet.id,
            transactionId: tx.id,
            direction: LedgerDirection.Debit,
            money,
            balanceBefore: mutation.balanceBefore,
            balanceAfter: mutation.balanceAfter,
          });
        } else if (tx.kind === WagerTransactionKind.Win || tx.kind === WagerTransactionKind.Refund) {
          const mutation = wallet.credit(money);
          ledgerEntry = WalletLedgerEntry.create({
            id: uuidv7(),
            walletId: wallet.id,
            transactionId: tx.id,
            direction: LedgerDirection.Credit,
            money,
            balanceBefore: mutation.balanceBefore,
            balanceAfter: mutation.balanceAfter,
          });
        } else if (tx.kind === WagerTransactionKind.Rollback) {
          const direction = tx.ledgerDirectionFor(reference);
          const mutation = direction === LedgerDirection.Credit ? wallet.credit(money) : wallet.debit(money, { guardOnly: true });
          ledgerEntry = WalletLedgerEntry.create({
            id: uuidv7(),
            walletId: wallet.id,
            transactionId: tx.id,
            direction,
            money,
            balanceBefore: mutation.balanceBefore,
            balanceAfter: mutation.balanceAfter,
          });
        } else if (tx.kind === WagerTransactionKind.Loss) {
          // LOSS não move saldo nem gera ledger.
        }
      } catch (err) {
        if (err instanceof InsufficientBalanceError) {
          tx.reject(FailureCode.InsufficientBalance);
        } else if (err instanceof NegativeBalanceGuardError) {
          tx.reject(FailureCode.NegativeBalanceGuard);
        } else {
          throw err;
        }
        await this.persistTerminal(scope, tx, eventCtx);
        return this.buildResult(tx, false, scope, cmd.walletId);
      }

      // ---- 7) Commit dos efeitos ---------------------------------------
      await scope.transactions.insert(tx);
      tx.markProcessed(reference?.id, new Date());
      await scope.transactions.save(tx);

      if (ledgerEntry) {
        await scope.ledger.insert(ledgerEntry);
        await scope.wallets.save(wallet);
        await scope.outbox.enqueue(WalletBalanceChanged.from(wallet, ledgerEntry, eventCtx));
      }

      await scope.outbox.enqueue(WagerTransactionProcessed.from(tx, eventCtx, wallet.balance.toJSON()));

      return this.buildResult(tx, false, scope, cmd.walletId, wallet.balance);
    });
  }

  private validateReference(tx: WagerTransaction, reference: WagerTransaction, money: Money): FailureCode | undefined {
    if (!tx.isValidReferenceKind(reference)) return FailureCode.InvalidReferenceKind;
    if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotTerminalProcessed;
    if (reference.playerId !== tx.playerId || reference.walletId !== tx.walletId || reference.roundId !== tx.roundId) {
      return FailureCode.ReferenceMismatch;
    }
    if (reference.money.currency !== money.currency) return FailureCode.CurrencyMismatch;
    if (!reference.money.equals(money)) return FailureCode.ReferenceAmountMismatch;
    return undefined;
  }

  private async persistTerminal(
    scope: WageringUnitOfWorkScope,
    tx: WagerTransaction,
    eventCtx: { correlationId: string; causationId?: string },
  ): Promise<void> {
    await scope.transactions.insert(tx);
    await scope.outbox.enqueue(WagerTransactionRejected.from(tx, eventCtx));
  }

  private async buildResult(
    tx: WagerTransaction | null,
    idempotentReplay: boolean,
    scope: WageringUnitOfWorkScope,
    walletId: string,
    knownBalance?: Money,
  ): Promise<SubmitWagerTransactionResult> {
    if (!tx) {
      // Só ocorre se uma mensagem SQS duplicada chegar antes de a
      // transação original ter sido, de fato, persistida — não deveria
      // acontecer dado que inbox e negócio commitam juntos, mas é tratado
      // defensivamente como falha transitória para forçar nova tentativa.
      throw new NotFoundError('WagerTransaction', 'unresolved-idempotent-replay');
    }

    let balance: MoneyProps | undefined;
    if (knownBalance) {
      balance = knownBalance.toJSON();
    } else if (tx.affectsBalance() && tx.status === WagerTransactionStatus.Processed) {
      const wallet = await scope.wallets.findById(walletId);
      balance = wallet?.balance.toJSON();
    }

    return {
      transactionId: tx.id,
      status: tx.status,
      idempotentReplay,
      ...(balance !== undefined ? { balance } : {}),
      ...(tx.failureCode !== undefined ? { failureCode: tx.failureCode } : {}),
    };
  }
}
