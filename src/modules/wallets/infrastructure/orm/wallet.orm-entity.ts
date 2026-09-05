import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';

/**
 * Entidade de PERSISTÊNCIA — não é o agregado de domínio. O domínio
 * (`Wallet`) não conhece decoradores do MikroORM nem tipos do ORM; a
 * conversão acontece explicitamente no `WalletMapper`.
 *
 * balance é armazenado como NUMERIC(18,2) — nunca float/double — e
 * reidratado como string decimal exata (o driver pg retorna NUMERIC como
 * string quando configurado corretamente; ver mikro-orm.config.ts).
 */
@Entity({ tableName: 'wallets' })
@Unique({ name: 'uq_wallets_player_currency', properties: ['playerId', 'currency'] })
export class WalletOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'player_id', type: 'uuid' })
  playerId!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: 'string', columnType: 'numeric(18,2)' })
  balance!: string;

  @Property({ type: 'number' })
  version!: number;

  @Property({ fieldName: 'created_at', type: 'Date' })
  createdAt!: Date;

  @Property({ fieldName: 'updated_at', type: 'Date' })
  updatedAt!: Date;
}
