import { Entity, PrimaryKey, Property, Index } from '@mikro-orm/core';

/**
 * Tabela append-only. Nenhum repositório expõe update/delete para esta
 * entidade — a imutabilidade é reforçada em dois níveis: na classe de
 * domínio (sem métodos de mutação) e aqui, pela ausência de qualquer método
 * de escrita no LedgerRepository além de `insert`. Uma trigger de banco
 * (ver migração 0004) também rejeita UPDATE/DELETE na tabela como última
 * linha de defesa.
 */
@Entity({ tableName: 'wallet_ledger_entries' })
@Index({ name: 'ix_ledger_wallet_created', properties: ['walletId', 'createdAt'] })
export class WalletLedgerEntryOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Property({ type: 'string' })
  direction!: string;

  @Property({ type: 'string', columnType: 'numeric(18,2)' })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ fieldName: 'balance_before', type: 'string', columnType: 'numeric(18,2)' })
  balanceBefore!: string;

  @Property({ fieldName: 'balance_after', type: 'string', columnType: 'numeric(18,2)' })
  balanceAfter!: string;

  @Property({ fieldName: 'created_at', type: 'Date' })
  createdAt!: Date;
}
