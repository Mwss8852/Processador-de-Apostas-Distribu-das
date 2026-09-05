import { Migration } from '@mikro-orm/migrations';

export class Migration0003_CreateLedger extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL REFERENCES wallets(id),
        transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
        direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount numeric(18,2) NOT NULL CHECK (amount > 0),
        currency char(3) NOT NULL,
        balance_before numeric(18,2) NOT NULL CHECK (balance_before >= 0),
        balance_after numeric(18,2) NOT NULL CHECK (balance_after >= 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_before + amount = balance_after)
          OR (direction = 'DEBIT' AND balance_before - amount = balance_after)
        )
      );
    `);
    this.addSql('CREATE INDEX ix_ledger_wallet_created ON wallet_ledger_entries (wallet_id, created_at DESC);');
    // No máximo um lançamento por (transaction_id, wallet_id) — uma
    // transação financeira produz no máximo um lançamento por carteira.
    this.addSql('CREATE UNIQUE INDEX uq_ledger_transaction_wallet ON wallet_ledger_entries (transaction_id, wallet_id);');

    // Imutabilidade estrutural: nenhuma sessão pode alterar ou apagar um
    // lançamento já gravado, mesmo por engano ou acesso direto ao banco.
    this.addSql(`
      CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only: % is not allowed', TG_OP;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER trg_forbid_ledger_update
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS trg_forbid_ledger_update ON wallet_ledger_entries;');
    this.addSql('DROP FUNCTION IF EXISTS forbid_ledger_mutation;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
  }
}
