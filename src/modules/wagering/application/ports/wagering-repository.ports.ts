import { WagerTransaction } from '../../domain/wager-transaction';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export const WAGER_TRANSACTION_REPOSITORY = Symbol('WAGER_TRANSACTION_REPOSITORY');
export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');

export interface WagerTransactionRepositoryPort {
  insert(tx: WagerTransaction): Promise<void>;
  save(tx: WagerTransaction): Promise<void>;

  findById(id: string): Promise<WagerTransaction | null>;

  /** Chave de negócio: (providerId, externalTransactionId). */
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;

  /** Fonte da verdade de idempotência: Idempotency-Key. Índice único no banco. */
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;

  /** Usado para resolver referências de REFUND/ROLLBACK — deve pertencer ao
   * mesmo provider/player/wallet/currency/round (validado pelo caso de uso). */
  findReference(providerId: string, referenceExternalTransactionId: string): Promise<WagerTransaction | null>;

  /** Quantas vezes um kind já reverteu uma dada referência — usado para
   * impedir reversão dupla (REFUND/ROLLBACK). */
  countByReferenceAndKind(referenceTransactionId: string, kind: string): Promise<number>;

  /** Para o worker de reprocessamento (§7.1): transações PENDING_REFERENCE
   * cujo próximo backoff já venceu. */
  findDuePendingReference(now: Date, limit: number): Promise<WagerTransaction[]>;

  /** Atualiza apenas o campo de agendamento do próximo backoff — usado pelo
   * worker de reprocessamento após incrementar attempts sem resolver a
   * referência ainda. */
  scheduleNextAttempt(id: string, nextAttemptAt: Date): Promise<void>;

  listByWallet(walletId: string, cursor?: string, limit?: number): Promise<{ items: WagerTransaction[]; nextCursor?: string }>;
}

export interface LedgerRepositoryPort {
  insert(entry: WalletLedgerEntry): Promise<void>;
  listByWallet(walletId: string, cursor?: string, limit?: number): Promise<{ items: WalletLedgerEntry[]; nextCursor?: string }>;
  sumByWallet(walletId: string): Promise<{ credits: string; debits: string; count: number }>;
}
