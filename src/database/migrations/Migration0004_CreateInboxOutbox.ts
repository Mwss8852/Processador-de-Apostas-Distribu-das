import { Migration } from '@mikro-orm/migrations';

export class Migration0004_CreateInboxOutbox extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE inbox_messages (
        message_id text NOT NULL,
        consumer_name text NOT NULL,
        payload_hash text NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id text NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        published_at timestamptz
      );
    `);
    this.addSql('CREATE INDEX ix_outbox_due ON outbox_messages (published_at, next_attempt_at) WHERE published_at IS NULL;');
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
  }
}
