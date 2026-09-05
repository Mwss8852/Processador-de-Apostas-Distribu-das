import { Entity, PrimaryKey, Property, Unique, Index } from '@mikro-orm/core';

@Entity({ tableName: 'wager_transactions' })
@Unique({ name: 'uq_wager_tx_provider_external_id', properties: ['providerId', 'externalTransactionId'] })
@Unique({ name: 'uq_wager_tx_idempotency_key', properties: ['idempotencyKey'] })
@Index({ name: 'ix_wager_tx_wallet', properties: ['walletId'] })
@Index({ name: 'ix_wager_tx_status_due', properties: ['status', 'nextAttemptAt'] })
@Index({ name: 'ix_wager_tx_reference', properties: ['referenceTransactionId', 'kind'] })
export class WagerTransactionOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'provider_id', type: 'string' })
  providerId!: string;

  @Property({ fieldName: 'external_transaction_id', type: 'string' })
  externalTransactionId!: string;

  @Property({ fieldName: 'idempotency_key', type: 'string' })
  idempotencyKey!: string;

  @Property({ fieldName: 'payload_hash', type: 'string' })
  payloadHash!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'player_id', type: 'uuid' })
  playerId!: string;

  @Property({ fieldName: 'round_id', type: 'string' })
  roundId!: string;

  @Property({ fieldName: 'game_id', type: 'string' })
  gameId!: string;

  @Property({ type: 'string' })
  kind!: string;

  @Property({ type: 'string', columnType: 'numeric(18,2)' })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ fieldName: 'reference_external_transaction_id', type: 'string', nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ fieldName: 'reference_transaction_id', type: 'uuid', nullable: true })
  referenceTransactionId?: string;

  @Property({ fieldName: 'created_at', type: 'Date' })
  createdAt!: Date;

  @Property({ type: 'string' })
  status!: string;

  @Property({ fieldName: 'failure_code', type: 'string', nullable: true })
  failureCode?: string;

  @Property({ fieldName: 'processed_at', type: 'Date', nullable: true })
  processedAt?: Date;

  @Property({ type: 'number', default: 0 })
  attempts!: number;

  /** Usado exclusivamente pela fila de reprocessamento de PENDING_REFERENCE. */
  @Property({ fieldName: 'next_attempt_at', type: 'Date', nullable: true })
  nextAttemptAt?: Date;
}
