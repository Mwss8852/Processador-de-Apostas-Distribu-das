import { Migration } from '@mikro-orm/migrations';

export class Migration0001_CreateWallets extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id uuid NOT NULL,
        currency char(3) NOT NULL,
        balance numeric(18,2) NOT NULL,
        version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT ck_wallets_version_positive CHECK (version >= 1)
      );
    `);
    this.addSql(`
      CREATE UNIQUE INDEX uq_wallets_player_currency ON wallets (player_id, currency);
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS wallets;');
  }
}
