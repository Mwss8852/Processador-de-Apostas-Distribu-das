import { EntityManager, LockMode } from '@mikro-orm/postgresql';
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
   * `LockMode.PESSIMISTIC_PARTIAL_WRITE` = `FOR UPDATE SKIP LOCKED` no
   * driver Postgres do MikroORM: cada publicador concorrente pega um lote
   * DIFERENTE de linhas pendentes — nenhum trava esperando o outro, e
   * nenhuma mensagem é entregue a dois publicadores ao mesmo tempo. Esta é
   * a garantia central da seção 11 (múltiplos publicadores sem perder nem
   * duplicar indefinidamente).
   *
   * CORREÇÃO (bug encontrado rodando contra Postgres real): a versão
   * anterior usava SQL bruto via `em.getConnection().execute(...)`, que
   * NÃO participa da transação aberta por `em.transactional()` — o lock
   * era liberado imediatamente após o SELECT, permitindo que dois
   * publicadores concorrentes pegassem o mesmo lote. `em.find()` com
   * `lockMode` usa o EntityManager em si, que já está vinculado à
   * transação ativa.
   */
  async lockDueBatchForUpdate(limit: number): Promise<OutboxMessage[]> {
    const now = new Date();
    const rows = await this.em.find(
      OutboxMessageOrmEntity,
      {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      {
        orderBy: { occurredAt: 'ASC' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );

    return rows.map((orm) =>
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