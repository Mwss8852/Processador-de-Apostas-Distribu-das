import { WagerTransactionRepositoryPort, LedgerRepositoryPort } from './ports/wagering-repository.ports';
import { WalletRepositoryPort } from '@modules/wallets/application/ports/wallet-repository.port';
import { NotFoundError } from '@shared/application/application-errors';
import { Money, MoneyProps } from '@shared/domain/money';
import { LedgerDirection } from '../domain/wallet-ledger-entry';

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  status: string;
  kind: string;
  money: MoneyProps;
  failureCode?: string;
  processedAt?: string;
}

export class GetWagerTransactionUseCase {
  constructor(private readonly transactions: WagerTransactionRepositoryPort) {}

  async execute(transactionId: string): Promise<WagerTransactionView> {
    const tx = await this.transactions.findById(transactionId);
    if (!tx) throw new NotFoundError('WagerTransaction', transactionId);
    return this.toView(tx.id, tx.providerId, tx.externalTransactionId, tx.walletId, tx.status, tx.kind, tx.money.toJSON(), tx.failureCode, tx.processedAt);
  }

  async executeByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    const tx = await this.transactions.findByProviderAndExternalId(providerId, externalTransactionId);
    if (!tx) throw new NotFoundError('WagerTransaction', `${providerId}:${externalTransactionId}`);
    return this.toView(tx.id, tx.providerId, tx.externalTransactionId, tx.walletId, tx.status, tx.kind, tx.money.toJSON(), tx.failureCode, tx.processedAt);
  }

  private toView(
    transactionId: string,
    providerId: string,
    externalTransactionId: string,
    walletId: string,
    status: string,
    kind: string,
    money: MoneyProps,
    failureCode?: string,
    processedAt?: Date,
  ): WagerTransactionView {
    return {
      transactionId,
      providerId,
      externalTransactionId,
      walletId,
      status,
      kind,
      money,
      ...(failureCode ? { failureCode } : {}),
      ...(processedAt ? { processedAt: processedAt.toISOString() } : {}),
    };
  }
}

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Recalcula o saldo a partir do ledger completo e compara com o saldo
 * materializado da wallet. Divergências não são corrigidas silenciosamente
 * — apenas reportadas (o caller deve logar e incrementar a métrica
 * `wallet_reconciliation_divergence_total`, ver ObservabilityInterceptor).
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly wallets: WalletRepositoryPort,
    private readonly ledger: LedgerRepositoryPort,
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) throw new NotFoundError('Wallet', walletId);

    let calculated = Money.zero(wallet.currency);
    let checkedEntries = 0;
    let cursor: string | undefined;
    do {
      const page = await this.ledger.listByWallet(walletId, cursor, 500);
      for (const entry of page.items) {
        calculated = entry.direction === LedgerDirection.Credit ? calculated.add(entry.money) : calculated.subtract(entry.money);
        checkedEntries += 1;
      }
      cursor = page.nextCursor;
    } while (cursor);

    const difference = wallet.balance.subtract(calculated);
    return {
      walletId,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries,
    };
  }
}
