import { UnitOfWork } from '@shared/application/unit-of-work';
import { WalletRepositoryPort } from '@modules/wallets/application/ports/wallet-repository.port';
import { WagerTransactionRepositoryPort, LedgerRepositoryPort } from './wagering-repository.ports';
import { InboxRepositoryPort, OutboxRepositoryPort } from '@messaging/messaging-ports';

export const WAGERING_UNIT_OF_WORK = Symbol('WAGERING_UNIT_OF_WORK');

/**
 * Todos os repositórios expostos aqui compartilham o MESMO EntityManager
 * (mesma transação SQL). A implementação MikroORM (ver
 * infrastructure/mikro-orm-wagering-unit-of-work.ts) usa
 * `em.transactional(async (forkedEm) => { ... })` e constrói cada repositório
 * passando `forkedEm`.
 */
export interface WageringUnitOfWorkScope {
  wallets: WalletRepositoryPort;
  transactions: WagerTransactionRepositoryPort;
  ledger: LedgerRepositoryPort;
  inbox: InboxRepositoryPort;
  outbox: OutboxRepositoryPort;
}

export type WageringUnitOfWork = UnitOfWork<WageringUnitOfWorkScope>;
