import { EntityManager } from '@mikro-orm/postgresql';
import { InboxRepositoryPort, OutboxRepositoryPort } from '@messaging/messaging-ports';
import { InboxMessage } from '@messaging/inbox/inbox-message';
import { OutboxMessage } from '@messaging/outbox/outbox-message';
import { IntegrationEvent } from '@shared/kernel/integration-event';
import { InboxMessageOrmEntity, OutboxMessageOrmEntity } from './messaging.orm-entities';

export class MikroOrmInboxRepository implements InboxRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async findByConsumerAndMessage(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const orm = await this.em.findOne(InboxMessageOrmEntity, { consumerName, messageId });
    if (!orm) return null;
    return InboxMessage.rehydrate({
      messageId: orm.messageId,
      consumerName: orm.consumerName,
      payloadHash: orm.payloadHash,
      receivedAt: orm.receivedAt,
      processedAt: orm.processedAt,
    });
  }

  async insert(message: InboxMessage): Promise<void> {
    const orm = new InboxMessageOrmEntity();
    orm.messageId = message.messageId;
    orm.consumerName = message.consumerName;
    orm.payloadHash = message.payloadHash;
    orm.receivedAt = message.receivedAt;
    orm.processedAt = message.processedAt;
    this.em.persist(orm);
    await this.em.flush();
  }

  async save(message: InboxMessage): Promise<void> {
    const orm = await this.em.findOneOrFail(InboxMessageOrmEntity, {
      consumerName: message.consumerName,
      messageId: message.messageId,
    });
    orm.processedAt = message.processedAt;
    await this.em.flush();
  }
}

export class MikroOrmOutboxRepository implements OutboxRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async enqueue(event: IntegrationEvent<unknown>): Promise<void> {
    const message = OutboxMessage.enqueue(event);
    const orm = new OutboxMessageOrmEntity();
    orm.id = message.id;
    orm.aggregateId = message.aggregateId;
    orm.eventType = message.eventType;
    orm.payload = message.payload as Record<string, unknown>;
    orm.occurredAt = message.occurredAt;
    orm.attempts = message.attempts;
    orm.nextAttemptAt = message.nextAttemptAt;
    orm.publishedAt = message.publishedAt;
    this.em.persist(orm);
    await this.em.flush();
  }

  /**
   * `FOR UPDATE SKIP LOCKED`: cada publicador concorrente pega um lote
   * DIFERENTE de linhas pendentes — nenhum trava esperando o outro, e
   * nenhuma mensagem é entregue a dois publicadores ao mesmo tempo. Esta é
   * a garantia central da seção 11 (múltiplos publicadores sem perder nem
   * duplicar indefinidamente).
   *
   * O MikroORM v6 não expõe `SKIP LOCKED` via `LockMode` (só oferece
   * PESSIMISTIC_WRITE, que bloqueia/espera, e PESSIMISTIC_WRITE_OR_FAIL, que
   * lança erro imediatamente) — nenhum dos dois é o que queremos aqui.
   * Usamos SQL bruto na mesma conexão/transação do EntityManager forkado,
   * e então carregamos as entidades gerenciadas por id para que
   * `save()` (via `em.flush()`) funcione normalmente depois.
   */
  async lockDueBatchForUpdate(limit: number): Promise<OutboxMessage[]> {
    const conn = this.em.getConnection();
    const rows = await conn.execute<{ id: string }[]>(
      `SELECT id FROM outbox_messages
       WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now())
       ORDER BY occurred_at ASC
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const ormRows = await this.em.find(OutboxMessageOrmEntity, { id: { $in: ids } });
    // Preserva a ordem definida pelo SELECT acima (occurred_at ASC).
    const byId = new Map(ormRows.map((o) => [o.id, o]));
    return ids
      .map((id) => byId.get(id))
      .filter((o): o is OutboxMessageOrmEntity => o !== undefined)
      .map((orm) =>
        OutboxMessage.rehydrate({
          id: orm.id,
          aggregateId: orm.aggregateId,
          eventType: orm.eventType,
          payload: orm.payload,
          occurredAt: orm.occurredAt,
          attempts: orm.attempts,
          ...(orm.nextAttemptAt !== undefined ? { nextAttemptAt: orm.nextAttemptAt } : {}),
          ...(orm.publishedAt !== undefined ? { publishedAt: orm.publishedAt } : {}),
        }),
      );
  }

  async save(message: OutboxMessage): Promise<void> {
    const orm = await this.em.findOneOrFail(OutboxMessageOrmEntity, { id: message.id });
    orm.attempts = message.attempts;
    orm.nextAttemptAt = message.nextAttemptAt;
    orm.publishedAt = message.publishedAt;
    await this.em.flush();
  }
}
