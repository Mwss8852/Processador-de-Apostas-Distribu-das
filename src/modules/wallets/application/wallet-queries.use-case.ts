import { WalletRepositoryPort } from './ports/wallet-repository.port';
import { LedgerRepositoryPort } from '@modules/wagering/application/ports/wagering-repository.ports';
import { NotFoundError } from '@shared/application/application-errors';
import { MoneyProps } from '@shared/domain/money';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class GetWalletUseCase {
  constructor(private readonly wallets: WalletRepositoryPort) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) throw new NotFoundError('Wallet', walletId);
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }
}

/** Lista todas as carteiras cadastradas — não faz parte do desafio
 * original, adicionado como conveniência operacional/administrativa. */
export class ListWalletsUseCase {
  constructor(private readonly wallets: WalletRepositoryPort) {}

  async execute(cursor?: string, limit = 50): Promise<{ items: WalletView[]; nextCursor?: string }> {
    const page = await this.wallets.listAll(cursor, limit);
    return {
      items: page.items.map((w) => ({ id: w.id, playerId: w.playerId, balance: w.balance.toJSON(), version: w.version })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
}

/**
 * Não existe um agregado "Player" no domínio (o desafio não define um) —
 * um jogador é identificado apenas pelo `playerId` que carrega em cada
 * Wallet. "Consultar o jogador" na prática é consultar a(s) carteira(s)
 * dele, uma por moeda (invariante 6.2: no máximo uma carteira por
 * playerId+currency).
 */
export class GetWalletByPlayerUseCase {
  constructor(private readonly wallets: WalletRepositoryPort) {}

  async execute(playerId: string, currency = 'BRL'): Promise<WalletView> {
    const wallet = await this.wallets.findByPlayerAndCurrency(playerId, currency);
    if (!wallet) throw new NotFoundError('Wallet for player', `${playerId} (${currency})`);
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export class ListWalletLedgerUseCase {
  constructor(
    private readonly wallets: WalletRepositoryPort,
    private readonly ledger: LedgerRepositoryPort,
  ) {}

  async execute(walletId: string, cursor?: string, limit = 50): Promise<{ items: LedgerEntryView[]; nextCursor?: string }> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) throw new NotFoundError('Wallet', walletId);

    const page = await this.ledger.listByWallet(walletId, cursor, limit);
    return {
      items: page.items.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        createdAt: e.createdAt.toISOString(),
      })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
}
