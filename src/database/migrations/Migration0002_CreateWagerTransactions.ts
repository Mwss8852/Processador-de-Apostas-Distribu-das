import { Migration } from '@mikro-orm/migrations';

export class Migration0002_CreateWagerTransactions extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id text NOT NULL,
        external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL,
        payload_hash text NOT NULL,
        wallet_id uuid NOT NULL REFERENCES wallets(id),
        player_id uuid NOT NULL,
        round_id text NOT NULL,
        game_id text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric(18,2) NOT NULL CHECK (amount >= 0),
        currency char(3) NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id uuid REFERENCES wager_transactions(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code text,
        processed_at timestamptz,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        CONSTRAINT ck_wager_tx_reference_required CHECK (
          (kind IN ('REFUND','ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
          OR (kind NOT IN ('REFUND','ROLLBACK') AND reference_external_transaction_id IS NULL)
        )
      );
    `);
    this.addSql('CREATE UNIQUE INDEX uq_wager_tx_provider_external_id ON wager_transactions (provider_id, external_transaction_id);');
    this.addSql('CREATE UNIQUE INDEX uq_wager_tx_idempotency_key ON wager_transactions (idempotency_key);');
    this.addSql('CREATE INDEX ix_wager_tx_wallet ON wager_transactions (wallet_id);');
    this.addSql("CREATE INDEX ix_wager_tx_status_due ON wager_transactions (status, next_attempt_at) WHERE status = 'PENDING_REFERENCE';");
    this.addSql('CREATE INDEX ix_wager_tx_reference ON wager_transactions (reference_transaction_id, kind);');
    // Impede reversão dupla do MESMO kind sobre a mesma referência a nível
    // de schema (além da checagem de aplicação via countByReferenceAndKind,
    // que fica sujeita a corrida entre o SELECT e o INSERT — este índice
    // único é a garantia final).
    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_tx_reference_kind_once
        ON wager_transactions (reference_transaction_id, kind)
        WHERE reference_transaction_id IS NOT NULL AND status = 'PROCESSED';
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
  }
}
