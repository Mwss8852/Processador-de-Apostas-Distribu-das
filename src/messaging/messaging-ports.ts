import { InboxMessage } from './inbox/inbox-message';
import { OutboxMessage } from './outbox/outbox-message';
import { IntegrationEvent } from '@shared/kernel/integration-event';

export const INBOX_REPOSITORY = Symbol('INBOX_REPOSITORY');
export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');

export interface InboxRepositoryPort {
  findByConsumerAndMessage(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  insert(message: InboxMessage): Promise<void>;
  save(message: InboxMessage): Promise<void>;
}

export interface OutboxRepositoryPort {
  enqueue(event: IntegrationEvent<unknown>): Promise<void>;
  /** Seleciona um lote de mensagens pendentes e devidas com
   * `FOR UPDATE SKIP LOCKED`, para que múltiplos publicadores concorrentes
   * nunca peguem a mesma linha (ver ARCHITECTURE.md §7 - Outbox). */
  lockDueBatchForUpdate(limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
}
