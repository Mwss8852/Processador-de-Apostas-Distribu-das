import { EntityManager, UniqueConstraintViolationException, QueryOrder } from '@mikro-orm/postgresql';
import {
  WagerTransactionRepositoryPort,
  LedgerRepositoryPort,
} from '@modules/wagering/application/ports/wagering-repository.ports';
import { WagerTransaction, WagerTransactionStatus } from '@modules/wagering/domain/wager-transaction';
import { WalletLedgerEntry } from '@modules/wagering/domain/wallet-ledger-entry';
import { WagerTransactionOrmEntity } from './wager-transaction.orm-entity';
import { WalletLedgerEntryOrmEntity } from './wallet-ledger-entry.orm-entity';
import { WagerTransactionMapper, WalletLedgerEntryMapper } from './wagering.mapper';
import { IdempotencyConflictError } from '@shared/application/application-errors';
import { encodeCursor, decodeCursor } from '@shared/application/cursor';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async insert(tx: WagerTransaction): Promise<void> {
    try {
      const orm = WagerTransactionMapper.toOrm(tx);
      this.em.persist(orm);
      await this.em.flush();
    } catch (err) {
      if (err instanceof UniqueConstraintViolationException) {
        // Corrida rara: duas requisições com a mesma Idempotency-Key
        // passaram pela checagem de leitura ao mesmo tempo. O índice único
        // do banco é a garantia final — traduzimos para o erro de domínio.
        throw new IdempotencyConflictError(tx.idempotencyKey);
      }
      throw err;
    }
  }

  async save(tx: WagerTransaction): Promise<void> {
    const orm = await this.em.findOneOrFail(WagerTransactionOrmEntity, { id: tx.id });
    WagerTransactionMapper.toOrm(tx, orm);
    await this.em.flush();
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    const orm = await this.em.findOne(WagerTransactionOrmEntity, { id });
    return orm ? WagerTransactionMapper.toDomain(orm) : null;
  }

  async findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const orm = await this.em.findOne(WagerTransactionOrmEntity, { providerId, externalTransactionId });
    return orm ? WagerTransactionMapper.toDomain(orm) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
    const orm = await this.em.findOne(WagerTransactionOrmEntity, { idempotencyKey });
    return orm ? WagerTransactionMapper.toDomain(orm) : null;
  }

  async findReference(providerId: string, referenceExternalTransactionId: string): Promise<WagerTransaction | null> {
    const orm = await this.em.findOne(WagerTransactionOrmEntity, {
      providerId,
      externalTransactionId: referenceExternalTransactionId,
    });
    return orm ? WagerTransactionMapper.toDomain(orm) : null;
  }

  async countByReferenceAndKind(referenceTransactionId: string, kind: string): Promise<number> {
    // Apenas reversões que de fato PROCESSARAM contam — uma tentativa
    // REJECTED anteriormente (ex.: valor incorreto) não deve bloquear uma
    // nova tentativa de reversão válida sobre a mesma referência.
    return this.em.count(WagerTransactionOrmEntity, {
      referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
  }

  async findDuePendingReference(now: Date, limit: number): Promise<WagerTransaction[]> {
    const rows = await this.em.find(
      WagerTransactionOrmEntity,
      {
        status: WagerTransactionStatus.PendingReference,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      { limit, orderBy: { createdAt: QueryOrder.ASC } },
    );
    return rows.map(WagerTransactionMapper.toDomain);
  }

  async scheduleNextAttempt(id: string, nextAttemptAt: Date): Promise<void> {
    const orm = await this.em.findOneOrFail(WagerTransactionOrmEntity, { id });
    orm.nextAttemptAt = nextAttemptAt;
    await this.em.flush();
  }

  async listByWallet(
    walletId: string,
    cursor?: string,
    limit = 50,
  ): Promise<{ items: WagerTransaction[]; nextCursor?: string }> {
    const after = cursor ? decodeCursor(cursor) : undefined;
    const rows = await this.em.find(
      WagerTransactionOrmEntity,
      { walletId, ...(after ? { createdAt: { $lt: after.createdAt }, id: { $ne: after.id } } : {}) },
      { limit: limit + 1, orderBy: { createdAt: QueryOrder.DESC } },
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(WagerTransactionMapper.toDomain);
    const last = page[page.length - 1];
    return {
      items,
      ...(hasMore && last ? { nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }) } : {}),
    };
  }
}

export class MikroOrmLedgerRepository implements LedgerRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    this.em.persist(WalletLedgerEntryMapper.toOrm(entry));
    await this.em.flush();
  }

  async listByWallet(walletId: string, cursor?: string, limit = 50): Promise<{ items: WalletLedgerEntry[]; nextCursor?: string }> {
    const after = cursor ? decodeCursor(cursor) : undefined;
    const rows = await this.em.find(
      WalletLedgerEntryOrmEntity,
      { walletId, ...(after ? { createdAt: { $lt: after.createdAt }, id: { $ne: after.id } } : {}) },
      { limit: limit + 1, orderBy: { createdAt: QueryOrder.DESC } },
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(WalletLedgerEntryMapper.toDomain);
    const last = page[page.length - 1];
    return {
      items,
      ...(hasMore && last ? { nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }) } : {}),
    };
  }

  async sumByWallet(walletId: string): Promise<{ credits: string; debits: string; count: number }> {
    const conn = this.em.getConnection();
    const result = await conn.execute<{ credits: string | null; debits: string | null; count: string }[]>(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::text AS credits,
         COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::text AS debits,
         COUNT(*)::text AS count
       FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    const row = result[0];
    return {
      credits: row?.credits ?? '0.00',
      debits: row?.debits ?? '0.00',
      count: Number(row?.count ?? '0'),
    };
  }
}
