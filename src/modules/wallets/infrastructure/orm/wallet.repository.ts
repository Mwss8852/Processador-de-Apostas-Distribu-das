import { EntityManager, LockMode, UniqueConstraintViolationException, QueryOrder } from '@mikro-orm/postgresql';
import { WalletRepositoryPort } from '@modules/wallets/application/ports/wallet-repository.port';
import { Wallet } from '@modules/wallets/domain/wallet';
import { WalletOrmEntity } from './wallet.orm-entity';
import { WalletMapper } from './wallet.mapper';
import { ConflictError } from '@shared/application/application-errors';
import { encodeCursor, decodeCursor } from '@shared/application/cursor';

/**
 * `findByIdForUpdate` usa `LockMode.PESSIMISTIC_WRITE`, que o MikroORM
 * traduz para `SELECT ... FOR UPDATE` no PostgreSQL — a linha da wallet
 * fica travada até o commit/rollback da transação corrente. Esta é a
 * estratégia de concorrência escolhida (ver ARCHITECTURE.md §5): bloqueio
 * pessimista por linha, escopado a uma única wallet, nunca um lock global.
 *
 * Alternativa considerada e descartada: bloqueio otimista via coluna
 * `version` com `UPDATE ... WHERE version = :expected` e retry. Descartada
 * porque, sob alta contenção na mesma wallet (o "hot wallet" da seção 8),
 * geraria retries em cadeia e trabalho descartado (a leitura de referência,
 * a validação, o cálculo do ledger — tudo refeito a cada tentativa). O
 * bloqueio pessimista serializa apenas o acesso à MESMA linha; carteiras
 * diferentes continuam processando em paralelo sem qualquer contenção.
 */
export class MikroOrmWalletRepository implements WalletRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    try {
      const orm = WalletMapper.toOrm(wallet);
      this.em.persist(orm);
      await this.em.flush();
    } catch (err) {
      if (err instanceof UniqueConstraintViolationException) {
        throw new ConflictError(`Wallet already exists for playerId="${wallet.playerId}" currency="${wallet.currency}"`);
      }
      throw err;
    }
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const orm = await this.em.findOne(WalletOrmEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return orm ? WalletMapper.toDomain(orm) : null;
  }

  async findById(id: string): Promise<Wallet | null> {
    const orm = await this.em.findOne(WalletOrmEntity, { id });
    return orm ? WalletMapper.toDomain(orm) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const orm = await this.em.findOne(WalletOrmEntity, { playerId, currency });
    return orm ? WalletMapper.toDomain(orm) : null;
  }

  async listAll(cursor?: string, limit = 50): Promise<{ items: Wallet[]; nextCursor?: string }> {
    const after = cursor ? decodeCursor(cursor) : undefined;
    const rows = await this.em.find(
      WalletOrmEntity,
      after
        ? {
            $or: [{ createdAt: { $lt: after.createdAt } }, { createdAt: after.createdAt, id: { $lt: after.id } }],
          }
        : {},
      { limit: limit + 1, orderBy: { createdAt: QueryOrder.DESC, id: QueryOrder.DESC } },
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(WalletMapper.toDomain);
    const last = page[page.length - 1];
    return {
      items,
      ...(hasMore && last ? { nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }) } : {}),
    };
  }

  async save(wallet: Wallet): Promise<void> {
    const orm = await this.em.findOneOrFail(WalletOrmEntity, { id: wallet.id });
    WalletMapper.toOrm(wallet, orm);
    await this.em.flush();
  }
}
