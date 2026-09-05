import { Entity, PrimaryKey, Property, Index } from '@mikro-orm/core';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageOrmEntity {
  @PrimaryKey({ fieldName: 'message_id', type: 'string' })
  messageId!: string;

  @PrimaryKey({ fieldName: 'consumer_name', type: 'string' })
  consumerName!: string;

  @Property({ fieldName: 'payload_hash', type: 'string' })
  payloadHash!: string;

  @Property({ fieldName: 'received_at', type: 'Date' })
  receivedAt!: Date;

  @Property({ fieldName: 'processed_at', type: 'Date', nullable: true })
  processedAt?: Date;
}

@Entity({ tableName: 'outbox_messages' })
@Index({ name: 'ix_outbox_due', properties: ['publishedAt', 'nextAttemptAt'] })
export class OutboxMessageOrmEntity {
  @Property({ type: 'uuid', primary: true })
  id!: string;

  @Property({ fieldName: 'aggregate_id', type: 'string' })
  aggregateId!: string;

  @Property({ fieldName: 'event_type', type: 'string' })
  eventType!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property({ fieldName: 'occurred_at', type: 'Date' })
  occurredAt!: Date;

  @Property({ type: 'number', default: 0 })
  attempts!: number;

  @Property({ fieldName: 'next_attempt_at', type: 'Date', nullable: true })
  nextAttemptAt?: Date;

  @Property({ fieldName: 'published_at', type: 'Date', nullable: true })
  publishedAt?: Date;
}
