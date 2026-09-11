import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { createTestOrm, truncateAll } from './setup';
import { MikroOrmOutboxRepository } from '@messaging/infrastructure/orm/messaging.repository';
import { IntegrationEvent } from '@shared/kernel/integration-event';

class TestEvent extends IntegrationEvent<{ n: number }> {
  readonly eventType = 'TestEvent';
  readonly version = 1;
  static create(n: number): TestEvent {
    return new TestEvent({ eventId: uuidv7(), aggregateId: `agg-${n}`, correlationId: uuidv7(), occurredAt: new Date(), data: { n } });
  }
}

describe('Outbox: publicadores concorrentes nunca disputam a mesma linha (§11)', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await createTestOrm();
  });

  afterAll(async () => {
    await orm.close();
  });

  beforeEach(async () => {
    await truncateAll(orm);
  });

  it('duas transações concorrentes com FOR UPDATE SKIP LOCKED pegam lotes disjuntos', async () => {
    const seedEm = orm.em.fork();
    const seedOutbox = new MikroOrmOutboxRepository(seedEm);
    // Seed paralelizada: 20 round-trips sequenciais contra um banco remoto
    // (Neon) somavam latência suficiente pra estourar o timeout do teste
    // antes mesmo de chegar na parte que ele realmente verifica.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => seedOutbox.enqueue(TestEvent.create(i))),
    );

    const emA = orm.em.fork();
    const emB = orm.em.fork();

    // Um SELECT ... FOR UPDATE adquire os locks de linha como parte da
    // própria execução da query — antes de retornar resultado algum. Então,
    // assim que o `lockDueBatchForUpdate` de A resolve, os locks JÁ estão
    // seguros no Postgres. Usamos essa garantia como uma barreira explícita
    // (em vez de um `setTimeout` arbitrário) para que B só tente seu
    // próprio SELECT FOR UPDATE SKIP LOCKED depois que A certamente já
    // segura os locks — eliminando a corrida de timing que fazia esse
    // teste ser instável (flaky) contra um banco serverless real (Neon).
    let signalAAcquiredLock: () => void;
    const aAcquiredLock = new Promise<void>((resolve) => {
      signalAAcquiredLock = resolve;
    });

    const [batchA, batchB] = await Promise.all([
      emA.transactional(async (tx) => {
        const batch = await new MikroOrmOutboxRepository(tx).lockDueBatchForUpdate(10);
        signalAAcquiredLock();
        // Mantém a transação (e os locks) abertos por tempo suficiente
        // para B completar sua própria tentativa antes de A commitar.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return batch;
      }),
      (async () => {
        await aAcquiredLock;
        return emB.transactional(async (tx) => new MikroOrmOutboxRepository(tx).lockDueBatchForUpdate(10));
      })(),
    ]);

    const idsA = new Set(batchA.map((m) => m.id));
    const idsB = new Set(batchB.map((m) => m.id));
    const intersection = [...idsA].filter((id) => idsB.has(id));

    expect(intersection).toHaveLength(0);
    expect(idsA.size + idsB.size).toBeLessThanOrEqual(20);
    expect(idsA.size + idsB.size).toBeGreaterThan(0);
  });

  it('uma publicação bem-sucedida marca publishedAt e não é pega novamente', async () => {
    const seedEm = orm.em.fork();
    const seedOutbox = new MikroOrmOutboxRepository(seedEm);
    await seedOutbox.enqueue(TestEvent.create(1));

    const em1 = orm.em.fork();
    await em1.transactional(async (tx) => {
      const repo = new MikroOrmOutboxRepository(tx);
      const [message] = await repo.lockDueBatchForUpdate(10);
      expect(message).toBeDefined();
      message!.markPublished(new Date());
      await repo.save(message!);
    });

    const em2 = orm.em.fork();
    const remaining = await em2.transactional(async (tx) => new MikroOrmOutboxRepository(tx).lockDueBatchForUpdate(10));
    expect(remaining).toHaveLength(0);
  });
});
