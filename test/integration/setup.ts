import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '@database/mikro-orm.config';
import { MikroOrmWageringUnitOfWork } from '@modules/wagering/infrastructure/orm/wagering-unit-of-work';

/**
 * Helper compartilhado pelos testes de integração e concorrência. Espera um
 * PostgreSQL real e migrado, apontado por DATABASE_URL (ver
 * docker-compose.yml e package.json -> scripts.test:integration).
 *
 * NÃO usamos mocks para Postgres/SQS aqui — isso é uma falha eliminatória
 * (seção 14). Os testes de unidade (test/unit) já cobrem o domínio isolado;
 * estes cobrem a integração real entre aplicação e infraestrutura.
 */
export async function createTestOrm(): Promise<MikroORM> {
  return MikroORM.init({
    ...mikroOrmConfig,
    clientUrl: process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering',
    debug: false,
  });
}

/**
 * Limpa todas as tabelas de negócio entre testes, preservando o schema.
 *
 * Usamos `DELETE FROM` na ordem de dependência (filhos antes dos pais),
 * não `TRUNCATE ... CASCADE`. TRUNCATE exige um `AccessExclusiveLock` em
 * TODAS as tabelas envolvidas de uma vez (por causa do CASCADE percorrendo
 * as foreign keys) — sob suites de teste rodando em paralelo, duas
 * conexões tentando truncar ao mesmo tempo podem pedir esses locks em
 * ordens diferentes e colidir em deadlock genuíno do Postgres (visto na
 * prática rodando os testes de integração/concorrência lado a lado).
 * `DELETE` pede apenas `RowExclusiveLock`, que não tem esse problema.
 */
export async function truncateAll(orm: MikroORM): Promise<void> {
  const conn = orm.em.getConnection();
  await conn.execute('DELETE FROM wallet_ledger_entries');
  await conn.execute('DELETE FROM wager_transactions');
  await conn.execute('DELETE FROM wallets');
  await conn.execute('DELETE FROM inbox_messages');
  await conn.execute('DELETE FROM outbox_messages');
}

export function newUow(orm: MikroORM): MikroOrmWageringUnitOfWork {
  return new MikroOrmWageringUnitOfWork(orm.em.fork());
}
