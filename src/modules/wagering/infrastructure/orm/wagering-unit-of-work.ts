import { EntityManager } from '@mikro-orm/postgresql';
import { WageringUnitOfWork, WageringUnitOfWorkScope } from '@modules/wagering/application/ports/wagering-unit-of-work';
import { MikroOrmWalletRepository } from '@modules/wallets/infrastructure/orm/wallet.repository';
import { MikroOrmWagerTransactionRepository, MikroOrmLedgerRepository } from '@modules/wagering/infrastructure/orm/wagering.repository';
import { MikroOrmInboxRepository, MikroOrmOutboxRepository } from '@messaging/infrastructure/orm/messaging.repository';
import { TransientInfrastructureError } from '@shared/application/application-errors';

/**
 * `em.transactional()` abre uma transação SQL real e passa um EntityManager
 * "forkado" (isolado, com seu próprio contexto de identidade) para o
 * callback. Cada repositório do scope é instanciado com ESSE EntityManager
 * — garantindo que todas as escritas (wallet, transaction, ledger, inbox,
 * outbox) participem da mesma transação e commitem/revertam atomicamente
 * (seção 11 do desafio).
 *
 * Nível de isolamento: READ COMMITTED (padrão do Postgres) é suficiente
 * aqui porque a exclusão mútua real vem do lock de linha explícito
 * (`SELECT ... FOR UPDATE` em `findByIdForUpdate`), não do nível de
 * isolamento da transação — ver ARCHITECTURE.md §5.
 */
export class MikroOrmWageringUnitOfWork implements WageringUnitOfWork {
  constructor(private readonly em: EntityManager) {}

  async run<T>(fn: (scope: WageringUnitOfWorkScope) => Promise<T>): Promise<T> {
    try {
      return await this.em.transactional(async (forkedEm) => {
        const scope: WageringUnitOfWorkScope = {
          wallets: new MikroOrmWalletRepository(forkedEm),
          transactions: new MikroOrmWagerTransactionRepository(forkedEm),
          ledger: new MikroOrmLedgerRepository(forkedEm),
          inbox: new MikroOrmInboxRepository(forkedEm),
          outbox: new MikroOrmOutboxRepository(forkedEm),
        };
        return fn(scope);
      });
    } catch (err) {
      // Erros de negócio (ConflictError, NotFoundError, etc.) são
      // relançados como estão — só embrulhamos falhas realmente
      // desconhecidas/infra como TransientInfrastructureError, para que a
      // camada HTTP e o consumer SQS saibam que é seguro reenviar.
      if (this.isKnownDomainOrApplicationError(err)) {
        throw err;
      }
      throw new TransientInfrastructureError('Unexpected failure while running the wagering transaction', err);
    }
  }

  private isKnownDomainOrApplicationError(err: unknown): boolean {
    const knownNames = new Set([
      'ConflictError',
      'NotFoundError',
      'IdempotencyConflictError',
      'InvalidPayloadError',
      'InvalidMoneyError',
      'MoneyCurrencyMismatchError',
      'InvalidTransactionStateError',
      'InsufficientBalanceError',
      'NegativeBalanceGuardError',
      'UnbalancedLedgerEntryError',
    ]);
    return err instanceof Error && knownNames.has(err.name);
  }
}
