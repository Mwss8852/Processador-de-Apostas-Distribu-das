import { IntegrationEvent } from '@shared/kernel/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_ATTEMPTS_BEFORE_ALERT = 10; // não move para DLQ sozinho: outbox é interno, apenas alarma/observa

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const json = event.toJSON();
    return new OutboxMessage(
      json.eventId,
      json.aggregateId,
      json.eventType,
      json as unknown as Readonly<Record<string, unknown>>,
      event.occurredAt,
      0,
      new Date(),
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  needsOperatorAttention(): boolean {
    return this.isPending() && this._attempts >= MAX_ATTEMPTS_BEFORE_ALERT;
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt com backoff
   * exponencial + jitter, limitado a MAX_BACKOFF_MS. */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const exponential = Math.min(BASE_BACKOFF_MS * 2 ** (this._attempts - 1), MAX_BACKOFF_MS);
    const jitter = Math.floor(Math.random() * 0.3 * exponential);
    this._nextAttemptAt = new Date(now.getTime() + exponential + jitter);
  }
}

