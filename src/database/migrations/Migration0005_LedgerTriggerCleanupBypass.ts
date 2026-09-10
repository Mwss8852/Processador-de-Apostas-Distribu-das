import { Migration } from '@mikro-orm/migrations';

export class Migration0005_LedgerTriggerCleanupBypass extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE OR REPLACE FUNCTION forbid_ledger_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF current_setting('app.allow_ledger_cleanup', true) = 'true' THEN
          RETURN NULL;
        END IF;
        RAISE EXCEPTION 'wallet_ledger_entries is append-only: % is not allowed', TG_OP;
      END;
      $$ LANGUAGE plpgsql;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      CREATE OR REPLACE FUNCTION forbid_ledger_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only: % is not allowed', TG_OP;
      END;
      $$ LANGUAGE plpgsql;
    `);
  }
}